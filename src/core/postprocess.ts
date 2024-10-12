"use strict";

import * as path from "path";
import {spawn, ChildProcessWithoutNullStreams} from "child_process";
import {Dvr, Config, MSG} from "./dvr";
import {Site, Streamer, CapInfo} from "./site";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "process";
import * as fs from "fs";
import { Upload } from "@aws-sdk/lib-storage";

const colors = require("colors");
const fsp = require('fs').promises;
const fse = require("fs-extra");

const R2 = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    }
});

export class PostProcess {

    protected dvr: Dvr;
    protected config: Config;
    protected postProcessQ: Array<CapInfo>;

    public constructor(dvr: Dvr) {
        this.dvr = dvr;
        this.config = dvr.config;
        this.postProcessQ = [];
    }

    public async add(capInfo: CapInfo) {
        this.postProcessQ.push(capInfo);
        if (this.postProcessQ.length === 1) {
            await this.convert();
        }
    }

    protected async convert() {

        const capInfo: CapInfo               = this.postProcessQ[0];
        const site: Site | undefined         = capInfo.site;
        const streamer: Streamer | undefined = capInfo.streamer;
        const namePrint: string              = streamer ? `${colors.name(streamer.nm)}` : "";
        const fileType: string               = this.config.recording.autoConvertType;
        const completeDir: string            = await this.getCompleteDir(site, streamer);
        const completeFile: string           = await this.uniqueFileName(completeDir, capInfo.filename, fileType) + (fileType === "m3u8" ? "" : "." + fileType);
        const capPath: string                = path.join(this.config.recording.captureDirectory, fileType === "m3u8" ? capInfo.filename : capInfo.filename + ".ts");
        const cmpPath: string                = path.join(completeDir, completeFile);

        if (fileType === "ts" || fileType === "m3u8") {
            this.dvr.print(MSG.DEBUG, `${namePrint} moving ${capPath} to ${cmpPath}`);
            await this.mv(capPath, cmpPath);
            await this.postScript(site, streamer, completeDir, completeFile);
            return;
        }

        const script: string = this.dvr.calcPath(this.config.recording.postprocess);
        const args: Array<string> = [ capPath, cmpPath, fileType ];

        this.dvr.print(MSG.INFO, `${namePrint} converting recording to ${fileType}`, site);
        this.dvr.print(MSG.DEBUG, `${namePrint} ${colors.cmd(script)} ${colors.cmd(args.join(" "))}`, site);

        const myCompleteProcess: ChildProcessWithoutNullStreams = spawn(script, args);
        if (site && streamer) {
            site.storeCapInfo(streamer, completeFile, myCompleteProcess, true);
        }

        myCompleteProcess.on("close", () => {
            void new Promise<void>(async () => {
                if (!this.config.recording.keepTsFile) {
                    try {
                        await fsp.access(args[0], fsp.F_OK);
                        await fsp.unlink(args[0]);
                    } catch (error: any) {
                        this.dvr.print(MSG.ERROR, `${args[0]} does not exist, cannot remove`);
                    }
                }

                this.dvr.print(MSG.INFO, `${namePrint} done converting ${colors.file(completeFile)}`, site);

                const searchDir = path.dirname(cmpPath);
                const entries = await fs.promises.readdir(searchDir);
                const cmpPathBase = path.basename(cmpPath);
                const cmpPathBaseNoExt = cmpPathBase.substring(0, cmpPathBase.lastIndexOf("."));
                this.dvr.print(MSG.DEBUG, `${namePrint} ${searchDir} ${cmpPathBase} ${cmpPathBaseNoExt}`, site);
                for (const ent of entries) {
                    if (ent.startsWith(cmpPathBaseNoExt)) {
                        try {
                            const upload = new Upload({
                                client: R2,
                                params: {
                                    Bucket: env.R2_BUCKET_NAME!,
                                    Key: `${streamer?.nm ?? "UNKNOWN"}/${ent}`,
                                    Body: fs.createReadStream(path.resolve(searchDir, ent)),
                                },
                            });
                            upload.on("httpUploadProgress", (progress) => {
                                this.dvr.print(MSG.INFO, `${namePrint} Uploading ${ent} (${progress})`, site);
                            });
                            await upload.done();
                            this.dvr.print(MSG.INFO, `${namePrint} Uploaded ${ent}`, site);
                        } catch (error) {
                            this.dvr.print(MSG.ERROR, `${namePrint} Failed to upload ${ent}: ${error}`, site);
                        }
                    }
                }

                await this.postScript(site, streamer, completeDir, completeFile);
            });
        });

        myCompleteProcess.on("error", (err: Error) => {
            this.dvr.print(MSG.ERROR, err.toString());
        });
    }

    protected async postScript(site: Site | undefined, streamer: Streamer | undefined, completeDir: string, completeFile: string) {
        if (!this.config.postprocess) {
            await this.nextConvert(site, streamer);
            return;
        }

        const script: string      = this.dvr.calcPath(this.config.postprocess);
        const args: Array<string> = [completeDir, completeFile];
        const namePrint: string   = streamer === undefined ? "" : `${colors.name(streamer.nm)}`;

        this.dvr.print(MSG.DEBUG, `${namePrint} running global postprocess script: ` +
            `${colors.cmd(script)} ${colors.cmd(args.join(" "))}`, site);
        const userPostProcess: ChildProcessWithoutNullStreams = spawn(script, args);

        if (site && streamer) {
            site.storeCapInfo(streamer, completeFile, userPostProcess, true);
        }

        userPostProcess.on("close", () => {
            this.dvr.print(MSG.INFO, `${namePrint} done post-processing ${colors.file(completeFile)}`, site);
            void new Promise<void>(async () => {
                await this.nextConvert(site, streamer);
            });
        });
    }

    protected async nextConvert(site: Site | undefined, streamer: Streamer | undefined) {

        if (site && streamer) {
            await site.clearProcessing(streamer);
        }

        // Pop current job, and start next conversion job (if any)
        this.postProcessQ.shift();
        if (this.postProcessQ.length > 0) {
            await this.convert();
        }
    }

    protected async getCompleteDir(site: Site | undefined, streamer: Streamer | undefined): Promise<string> {
        if (site && streamer) {
            const dir: string = await site.getCompleteDir(streamer);
            return dir;
        }

        return this.dvr.mkdir(this.config.recording.completeDirectory + "/UNKNOWN");
    }

    protected async uniqueFileName(completeDir: string, filename: string, fileType: string) {
        // If the output file already exists, make filename unique
        let count = 1;
        let fileinc = filename;
        let name = path.join(completeDir,  fileinc + "." + fileType);
        try {
            while (await fsp.access(name, fsp.F_OK)) {
                this.dvr.print(MSG.ERROR, name + " already exists");
                fileinc = filename + " (" + count.toString() + ")";
                name = path.join(completeDir, fileinc + "." + fileType);
                count++;
            }
        } catch (err: any) {
        }
        return fileinc;
    }

    protected async mv(oldPath: string, newPath: string) {

        try {
            await fse.move(oldPath, newPath);
        } catch (err: any) {
            if (err) {
                if (err.code === "EXDEV") {
                    try {
                        await fsp.copyFile(oldPath, newPath);
                        await fsp.unlink(oldPath);
                    } catch (err: any) {
                        if (err) {
                            this.dvr.print(MSG.ERROR, `${colors.site(oldPath)}: ${err.toString()}`);
                        }
                    }
                } else {
                    this.dvr.print(MSG.ERROR, `${colors.site(oldPath)}: ${err.toString()}`);
                }
            }
        }
    }

}
