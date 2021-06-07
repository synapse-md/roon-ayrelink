"use strict";

const AyreLink             = require("ayrelink"),
      RoonApi              = require("node-roon-api"),
      RoonApiSettings      = require("node-roon-api-settings"),
      RoonApiStatus        = require("node-roon-api-status"),
      RoonApiVolumeControl = require("node-roon-api-volume-control"),
      SerialPort           = require('serialport');

let roon = new RoonApi({
    extension_id:       'com.synapse-md.roon.ayrelink',
    display_name:       "AyreLink Volume Control Extension",
    display_version:    "1.0.0",
    publisher:          "synapse-md",
    email:              'nvpatel@mailnx.net'
});


// Build Roon settings and enable serial port validation
let mysettings = roon.load_config("settings") || {
        serialport:     "",
        model:          "KX-5",
        modelver:       true
};
if (mysettings.modelver) { mysettings.modelname = mysettings.model + " twenty" } else { mysettings.modelname = mysettings.model };

let ports = new Array();
ports.list = new Array();

function serialportsetup() {
    return new Promise(resolve =>{
        SerialPort.list().then(portsdetected => {
            portsdetected.forEach(function(port) {
                let portobj =  { title: port.path, value: port.path };
                ports.push(portobj);
                ports.list.push(port.path)
            });
            console.log("[AyreLink Extension] Serial ports detected: ");
            console.log(ports.list);
            if (!mysettings.serialport) {
                console.log("[AyreLink Extension] No serial port configured!");
            } else if (ports.list.indexOf(mysettings.serialport) < 0) {
                console.log("[AyreLink Extension] Configured port " + mysettings.serialport + " no longer exists!");
                mysettings.serialport = "";
            }
            resolve();
        });
    });
}

function makelayout(settings) {   
    let l = {
            values:    settings,
            layout:    [],
            has_error: false
    };
    l.layout.push({
        type:       "dropdown",
        title:      "Serial Port",
        values:     ports,
        setting:    "serialport"
    });
    l.layout.push({
        type:       "group",
        title:      "Preamplifier Settings",
        items:  [{
            type:       "dropdown",
            title:      "Model",
            values:     [
                { title: "blank", value: "" },
                { title: "KX-R", value: "KX-R" },
                { title: "KX-5", value: "KX-5" }
            ],
            setting:    "model"
        },
        {
            type:       "dropdown",
            title:      '"Twenty" upgrade',
            values:    [
                { title: "Yes", value: true },
                { title: "No",  value: false }
            ],
            setting:    "modelver"
        }]
    });
    return l;
};

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(mysettings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            var oldmodel = mysettings.model;
            var oldmodelver = mysettings.modelver;
            var oldport = mysettings.serialport;

            mysettings = l.values;
            if (mysettings.modelver) { mysettings.modelname = mysettings.model + " Twenty" } else { mysettings.modelname = mysettings.model };

            let force = false;
            if (oldmodel != mysettings.model) force = true;
            if (oldmodelver != mysettings.modelver) force = true;
            if (oldport != mysettings.serialport) force = true;
            if (force) {
                console.log("[Extension] Settings have changed.");
                updatestatus();
                ayrelinkstart();
            };
            roon.save_config("settings",mysettings);
        }
    }
});


// Initialize status service and create handler function
var svc_status = new RoonApiStatus(roon);

function updatestatus() {
    if ((ayrelink.source_control) || (ayrelink.volume_control)) {
        svc_status.set_status(ayrelink.control.status.summary);
        if (ayrelink.control.updatetype == "vol") {
            ayrelink.volume_control.update_state({ volume_value: ayrelink.control.status.preampvolume });
        }
        if ((ayrelink.control.updatetype == "status") && (ayrelink.volume_control)) {
            if (ayrelink.control.status.preampstatus == "MUTE") ayrelink.volume_control.update_state({ is_muted: true });
            if (ayrelink.control.status.preampstatus == "ON") ayrelink.volume_control.update_state({ is_muted: false });
        }
        if ((ayrelink.control.updatetype == "status") && (ayrelink.source_control)) {
            if (ayrelink.control.status.preampstatus == "MUTE") ayrelink.source_control.update_state({ standby: "deselected" });
            if (ayrelink.control.status.preampstatus == "ON") ayrelink.source_control.update_state({ standby: "deselected" });
            if (ayrelink.control.status.preampstatus == "OFF") ayrelink.source_control.update_state({ standby: "selected" });
        }
        ayrelink.control.updatetype = undefined;
    } else if (!mysettings.serialport) {
        svc_status.set_status("No Serial Port Configured");
    } else if (!mysettings.model) {
        svc_status.set_status("No Supported Device Configured");
    } else {
        svc_status.set_status("Set to " + mysettings.modelname + " on " + mysettings.serialport, false);
    }
};

// Set up AyreLink and Roon volume controls
let ayrelink = { };
ayrelink.control = new AyreLink();
var svc_volume_control = new RoonApiVolumeControl(roon);

updatestatus();

function ayrelinkstart() {
    if (ayrelink.volume_control) { ayrelink.volume_control.destroy(); delete(ayrelink.volume_control); };
        
    console.log("[AyreLink] Starting AyreLink to " + mysettings.modelname + " on " + mysettings.serialport + "...");
    
    ayrelink.control.start(mysettings)
        .then(() => console.log("[AyreLink Extension] Started AyreLink to " + mysettings.modelname + " on " + mysettings.serialport + "..."))
        .catch(error => console.log("[AyreLink Extension] Failed to start AyreLink"));

    ayrelink.control.on('statusupdate', updatestatus);
    ayrelink.control.on('connected', ev_connected);    
}

// Let's go, but populate and validate serial ports first
serialportsetup().then(() => {
    ayrelinkstart();
    roon.init_services({ provided_services: [ svc_status, svc_settings, svc_volume_control ] });
    roon.start_discovery();
});

// event handlers below

function ev_connected() {
    let control = ayrelink.control;

    console.log("[AyreLink Extension] Received response from " + control.config.devicename);
    
    ayrelink.volume_control = svc_volume_control.new_device({
        state: {
            display_name: control.config.devicename,
            volume_type:  control.config.voltype,
            volume_min:   control.config.volmin,
            volume_max:   control.config.volmax,
            volume_value: control.status.preampvolume,
            volume_step:  control.config.volstep,
            is_muted:     control.status.preampstatus == "MUTE"
        },
        set_volume: function (volume) {
            control.set_volume("K",volume.body.value);
        },
        set_mute: function (mute) {
            console.log("mute request");
            console.log(mute.body);
            if (mute.body.mode == "on") {
                control.set_state("K","M");
            } else if ((mute.body.mode == "off") && (control.status.preampstatus != "STANDBY")) {
                control.set_state("K","N");
            }
        }
        });
        console.log("[CONNECTED EVENT]");
}
