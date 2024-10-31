/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

define(function (require) {

    "use strict";

    var Backbone = require('backbone'),

    // in Json-land, checkSchema is a promise that always returns success
    checkSchema = function () {
        var deferred = $.Deferred();
        console.log("checkSchema: entry");
        deferred.resolve();
        return deferred.promise();            
    },

    Project = Backbone.Model.extend({
        // default values
        defaults: {
            projectid: "",
            SourceFont: "Source Sans",
            SourceFontSize: "16",
            SourceColor: "#0000aa",
            TargetFont: "Source Sans",
            TargetFontSize: "16",
            TargetColor: "#000000",
            NavigationFont: "Source Sans",
            NavigationFontSize: "16",
            NavigationColor: "#00cc00",
            SpecialTextColor: "#aa0000",
            RetranslationColor: "#996633",
            TextDifferencesColor: "rgb(40, 100, 40)",
            SourceLanguageName: "",
            TargetLanguageName: "",
            SourceLanguageCode: "",
            TargetLanguageCode: "",
            SourceVariant: "",
            TargetVariant: "",
            CopyPunctuation: "true",
            PunctPairs: [
                {
                    s: "?",
                    t: "?"
                },
                {
                    s: ".",
                    t: "."
                },
                {
                    s: ",",
                    t: ","
                },
                {
                    s: ";",
                    t: ";"
                },
                {
                    s: ":",
                    t: ":"
                },
                {
                    s: "\"",
                    t: "\""
                },
                {
                    s: "!",
                    t: "!"
                },
                {
                    s: "(",
                    t: "("
                },
                {
                    s: ")",
                    t: ")"
                },
                {
                    s: "<",
                    t: "<"
                },
                {
                    s: ">",
                    t: ">"
                },
                {
                    s: "{",
                    t: "{"
                },
                {
                    s: "}",
                    t: "}"
                },
                {
                    s: "“",
                    t: "“"
                },
                {
                    s: "”",
                    t: "”"
                },
                {
                    s: "‘",
                    t: "‘"
                },
                {
                    s: "’",
                    t: "’"
                },
                {
                    s: "'",
                    t: "'"
                },
                {
                    s: "«",
                    t: "«"
                },
                {
                    s: "»",
                    t: "»"
                },
                {
                    s: "¿",
                    t: "¿"
                },
                {
                    s: "¡",
                    t: "¡"
                },
                {
                    s: "—",
                    t: "—"
                }
            ],
            AutoCapitalization: "false",
            SourceHasUpperCase: "false",
            CasePairs: [
                {
                    s: "aA",
                    t: "aA"
                },
                {
                    s: "bB",
                    t: "bB"
                },
                {
                    s: "cC",
                    t: "cC"
                },
                {
                    s: "dD",
                    t: "dD"
                },
                {
                    s: "eE",
                    t: "eE"
                },
                {
                    s: "fF",
                    t: "fF"
                },
                {
                    s: "gG",
                    t: "gG"
                },
                {
                    s: "hH",
                    t: "hH"
                },
                {
                    s: "iI",
                    t: "iI"
                },
                {
                    s: "jJ",
                    t: "jJ"
                },
                {
                    s: "kK",
                    t: "kK"
                },
                {
                    s: "lL",
                    t: "lL"
                },
                {
                    s: "mM",
                    t: "mM"
                },
                {
                    s: "nN",
                    t: "nN"
                },
                {
                    s: "oO",
                    t: "oO"
                },
                {
                    s: "pP",
                    t: "pP"
                },
                {
                    s: "qQ",
                    t: "qQ"
                },
                {
                    s: "rR",
                    t: "rR"
                },
                {
                    s: "sS",
                    t: "sS"
                },
                {
                    s: "tT",
                    t: "tT"
                },
                {
                    s: "uU",
                    t: "uU"
                },
                {
                    s: "vV",
                    t: "vV"
                },
                {
                    s: "wW",
                    t: "wW"
                },
                {
                    s: "xX",
                    t: "xX"
                },
                {
                    s: "yY",
                    t: "yY"
                },
                {
                    s: "zZ",
                    t: "zZ"
                }
            ],
            SourceDir: "",
            TargetDir: "",
            NavDir: "",
            name: "",
            CustomFilters: "false",
            FilterMarkers: "\\lit \\_table_grid \\_header \\_intro_base \\x \\r \\cp \\_horiz_rule \\ie \\rem \\_unknown_para_style \\_normal_table \\note \\_heading_base \\_hidden_note \\_footnote_caller \\_dft_para_font \\va \\_small_para_break \\_footer \\_vernacular_base \\pro \\xt \\_notes_base \\__normal \\xdc \\ide \\mr \\xq \\_annotation_ref \\_annotation_text \\_peripherals_base \\_gls_lang_interlinear \\free \\rq \\_nav_lang_interlinear \\_body_text \\cl \\xot \\efm \\bt \\_unknown_char_style \\_double_boxed_para \\_hdr_ftr_interlinear \\xk \\_list_base \\ib \\xnt \\fig \\restore \\_src_lang_interlinear \\vp \\_tgt_lang_interlinear \\ef \\ca \\xo \\_single_boxed_para \\sts"
        },
    }),

    ProjectCollection = Backbone.Collection.extend({
        model: Project,
        url: function() {
            // TODO: global function to prepend server:port to url path
            // return this.document.url() + '/projects';
            return "http://localhost:3042/projects";
        },

        // parse: function (data) {
        //     if (_.isObject(data.results)) {
        //         console.log("Parsing project data results: " + data.results);
        //         return data.results;
        //     } else {
        //         console.log("Parsing project data: " + data);
        //         return data;
        //     }
        // },

        fetch: function(options) {

            console.log("Fetching project"); 

            //Call Backbone's fetch
            return Backbone.Collection.prototype.fetch.call(this, options);
        }

        // sync: function (method, model, options) {
        //     if (method === "read") {
        //         // special case for sql - remove the blank name property for json
        //         if (options.data.hasOwnProperty('name') && options.data.name === "") {
        //             delete options.data.name;
        //         }
        //     }
        // }

    });

    return {
        checkSchema: checkSchema,
        Project: Project,
        ProjectCollection: ProjectCollection
    };

});