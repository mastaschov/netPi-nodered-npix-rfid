## Node-RED + npix rfid nodes

Made for [netPI](https://www.netiot.com/netpi/), the Open Edge Connectivity Ecosystem

### Debian with Node-RED and rfid nodes for NIOT-E-NPIX-RFID extension module

The image provided hereunder deploys a container with installed Debian, openJDK 7, LLRP toolkit (.jar), Node-RED and rfid nodes to communicate with an extension module NIOT-E-NPIX-RFID.

Base of this image builds a tagged version of [debian:jessie](https://hub.docker.com/r/resin/armv7hf-debian/tags/) with installed Internet of Things flow-based programming web-tool [Node-RED](https://nodered.org/),three nodes *rfid*, *rfid gpi* and *rfid gpo* providing access to the extension module.  The *rfid* node communicates to the module across a serial connection over device `/dev/ttyS0`. The node *rfid gpi* inputs the status of the 24VDC compatible input pin#2 (0V reference on pin#1) located at the module's 3-pin terminal. The node *rfid gpo* activates/deactivates 24 VDC at the output contact pin#3 (GND reference at netPI's power connector) of the terminal. 

ATTENTION! Never plug or unplug any extension module if netPI is powered. Make sure a module is already inserted before applying 24VDC to netPI. Also do not operate the RFID module without any antenna connected.

#### Licenses

The openJDK software is lisened under [GNU General Public License, version 2](http://openjdk.java.net/legal/gplv2+ce.html).

The LLRP toolkit is licensed under [the Apache license, Version 2.0](http://www.apache.org/licenses/LICENSE-2.0.html).

#### Container prerequisites

##### Port mapping

To grant web access to the containerized Node-RED programming tool its used port `1880` needs to be exposed to the host.

##### Privileged mode

The nodes *rfid*, *rfid gpi* and *rfid gpo* enable the module and control its LEDs across GPIOs 17, 22 and 23. Only the privileged mode option lifts the enforced container limitations to allow usage of GPIOs in a container.

##### Host device

The serial port device `/dev/ttyS0` needs to be added to the container. The device is available only if an inserted module has been recognized by netPI during boot process. Else the container will fail to start.

#### Getting started

STEP 1. Open netPI's landing page under `https://<netpi's ip address>`.

STEP 2. Click the Docker tile to open the [Portainer.io](http://portainer.io/) Docker management user interface.

STEP 3. Enter the following parameters under **Containers > Add Container**

* **Image**: `hilschernetpi/netpi-nodered-npix-rfid`

* **Port mapping**: `Host "1880" (any unused one) -> Container "1880"`

* **Restart policy"** : `always`

* **Runtime > Devices > add device**: `Host "/dev/ttyS0" -> Container "/dev/ttyS0"`

* **Runtime > Privileged mode** : `On`

STEP 4. Press the button **Actions > Start container**

Pulling the image from Docker Hub may take up to 5 minutes.

#### Accessing

After starting the container open Node-RED in your browser with `http://<netpi's ip address>:<mapped host port>` (NOT https://) e.g. `http://192.168.0.1:1880`. Three nodes *rfid*, *rfid gpi* and *rfid gpo* in the nodes *npix* library palette provide you access to the RFID module. Their info tabs explain how to use them.

#### GitHub sources
The image is built from the GitHub project [netPI-nodered-npix-rfid](https://github.com/Hilscher/netPI-nodered-npix-rfid). It complies with the [Dockerfile](https://docs.docker.com/engine/reference/builder/) method to build a Docker image [automated](https://docs.docker.com/docker-hub/builds/).

View the license information for the software in the Github project. As with all Docker images, these likely also contain other software which may be under other licenses (such as Bash, etc from the base distribution, along with any direct or indirect dependencies of the primary software being contained).
As for any pre-built image usage, it is the image user's responsibility to ensure that any use of this image complies with any relevant licenses for all software contained within.

To build the container for an ARM CPU on [Docker Hub](https://hub.docker.com/)(x86 based) the Dockerfile uses the method described here [resin.io](https://resin.io/blog/building-arm-containers-on-any-x86-machine-even-dockerhub/).

[![N|Solid](http://www.hilscher.com/fileadmin/templates/doctima_2013/resources/Images/logo_hilscher.png)](http://www.hilscher.com)  Hilscher Gesellschaft fuer Systemautomation mbH  www.hilscher.com
