#use latest armv7hf compatible raspbian OS version from group resin.io as base image
FROM balenalib/armv7hf-debian:stretch

#enable building ARM container on x86 machinery on the web (comment out next line if built on Raspberry) 
#RUN [ "cross-build-start" ]

#labeling
LABEL maintainer="netpi@hilscher.com" \ 
      version="V0.9.1.0" \
      description="Debian with a standard Node-RED installation, openJDK and additional rfid nodes for NIOT-E-NPIX-RFID expansion module"

#version
ENV HILSCHERNETPI_NODERED_NPIX_RFID_VERSION 0.9.1.0

#java options
ENV _JAVA_OPTIONS -Xms64M -Xmx128m

#copy files
COPY "./init.d/*" /etc/init.d/
COPY "./node-red-contrib-rfid/*" "./node-red-contrib-rfid/lib/*" /tmp/

#do installation
RUN apt-get update  \
    && apt-get install curl build-essential 
#install node.js
RUN curl -sL https://deb.nodesource.com/setup_6.x | sudo -E bash -  \
    && apt-get install -y nodejs  \
#install Node-RED
    && npm install -g --unsafe-perm node-red \
#install openJDK7
    && apt-get install openjdk-8-jdk \
#install nodes
    && mkdir /usr/lib/node_modules/node-red-contrib-rfid /usr/lib/node_modules/node-red-contrib-rfid/lib \
    && mv ./tmp/rfid.js ./tmp/rfid.html /tmp/package.json ./tmp/RfidNode.jar /usr/lib/node_modules/node-red-contrib-rfid \
    && mv ./tmp/ltkjava-1.0.0.6.jar /usr/lib/node_modules/node-red-contrib-rfid/lib \
    && cd /usr/lib/node_modules/node-red-contrib-rfid/ \
    && npm install \
#clean up
    && rm -rf /tmp/* \
    && apt-get remove curl \
    && apt-get -yqq autoremove \
    && apt-get -y clean \
    && rm -rf /var/lib/apt/lists/*

#set the entrypoint
ENTRYPOINT ["/etc/init.d/entrypoint.sh"]

#Node-RED Port
EXPOSE 1880

#set STOPSGINAL
STOPSIGNAL SIGTERM

#stop processing ARM emulation (comment out next line if built on Raspberry)
RUN [ "cross-build-end" ]
