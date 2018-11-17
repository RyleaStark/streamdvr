const streamlink = require("../core/streamlink");

class Fc2 extends streamlink.Streamlink {
    constructor(tui) {
        super("FC2", tui, "https://live.fc2.com/", true, "best");
    }
}

exports.Plugin = Fc2;

