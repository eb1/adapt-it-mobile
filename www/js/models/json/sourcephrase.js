/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

define(function (require) {

    "use strict";

    var Backbone = require('backbone'),

    SourcePhrase = Backbone.Model.extend({
        // default values
        defaults: {
            spid: "",
            chapterid: "",
            vid: "", // 1.6 (verse ID for multiple imports)
            norder: 0,
            markers: "",
            orig: null,
            prepuncts: "",
            midpuncts: "",
            follpuncts: "",
            flags: "0000000000000000000000", // 22
            texttype: 0,
            gloss: "",
            freetrans: "",
            note: "",
            srcwordbreak: "",
            tgtwordbreak: "",
            source: "", // source includes punctuation as of 1.2 (was inconsistent before)
            target: ""
        },

    }),

    SourcePhraseCollection = Backbone.Collection.extend({
        model: SourcePhrase,
        url: function() {
            // TODO: global function to prepend server:port to url path
            // return this.document.url() + '/sourcephrases';
            return "http://localhost:3042/sourcephrases";
        }
    });

    return {
        SourcePhrase: SourcePhrase,
        SourcePhraseCollection: SourcePhraseCollection
    };

});