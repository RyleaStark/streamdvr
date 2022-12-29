FROM lsiobase/alpine:3.16
LABEL org.opencontainers.image.description "StreamDVR - A personal digital video recorder that helps enable personal time shifting."

ARG HEALTHCHECKS_ID

ENV STREAMDVR_VERSION=master \
    YOUTUBEDL_VERSION=2021.06.06 \
    STREAMLINK_VERSION=5.1.2 \
    S5CMD_VERSION=2.0.0 \
    YT_DLP_VERSION=2021.09.02 \
    HOME="/app/.home"

RUN \
 echo "**** install dependencies ****" && \
 apk add --no-cache \
	curl \
	nodejs-current \
	npm \
	python3 \ 
	python3-dev \
	py3-pip \
	py3-setuptools \
	ca-certificates \
	bash \
	git \
	build-base \
	libgomp \
	libxslt-dev \
	libxml2-dev \
	ffmpeg && \
 echo "**** install packages ****" && \
 	pip3 install youtube-dl==${YOUTUBEDL_VERSION} streamlink==${STREAMLINK_VERSION} yt-dlp==${YT_DLP_VERSION} && \
	git clone https://github.com/back-to/generic.git /tmp/generic && \
  mkdir -p /app/.home/.local/share/streamlink/ && \
  mv /tmp/generic/plugins /app/.home/.local/share/streamlink/ && \
 echo "**** install streamdvr ****" && \
  wget -qO- https://github.com/RyleaStark/StreamDVR/archive/refs/heads/${STREAMDVR_VERSION}.tar.gz | tar -xvz -C /tmp && \
  mv /tmp/StreamDVR-${STREAMDVR_VERSION}/* /app/ && cd /app && \ 
	npm ci --only=production && \
 echo "**** install s5cmd ****" && \
  wget -qO- https://github.com/peak/s5cmd/releases/download/v${S5CMD_VERSION}/s5cmd_${S5CMD_VERSION}_Linux-64bit.tar.gz | tar -xvz -C /tmp && \
  mv /tmp/s5cmd /app/ && cd /app && \ 
 echo "**** cleaning up ****" && \
	npm cache clean --force && \
  apk del git build-base && \
  rm -rf /tmp/*

COPY /root /

WORKDIR /app

VOLUME /app/config /app/capturing /app/captured

HEALTHCHECK --interval=300s --timeout=15s --start-period=10s \
            CMD curl -L https://hc-ping.com/${HEALTHCHECKS_ID}
