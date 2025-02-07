/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

define(function (require) {

    "use strict";

    var Backbone = require('backbone'),

    TargetUnit = Backbone.Model.extend({
        // default values
        defaults: {
            tuid: "",
            projectid: "",
            source: "",
            mn: 1,
            f: "0",
            refstring: [],
            timestamp: "",
            user: "",
            isGloss: 1
        },

    }),

    TargetUnitCollection = Backbone.Collection.extend({
        model: TargetUnit,
        url: function() {
            // TODO: global function to prepend server:port to url path
            // return this.document.url() + '/targetunits';
            return "http://localhost:3042/targetunits";
        },

        parse: function (data) {
            return data.targetunits;
        }
    });

    return {
        TargetUnit: TargetUnit,
        TargetUnitCollection: TargetUnitCollection
    };

});