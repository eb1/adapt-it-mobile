/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

define(function (require) {

    "use strict";

    var Backbone = require('backbone'),

    Chapter = Backbone.Model.extend({
        // default values
        defaults: {
            chapterid: "",
            bookid: "",
            projectid: "",
            name: "",
            lastadapted: 0,
            versecount: 0
        },

    }),

    ChapterCollection = Backbone.Collection.extend({
        model: Chapter,
        url: function() {
            // TODO: global function to prepend server:port to url path
            // return this.document.url() + '/chapters';
            return "http://localhost:3042/chapters";
        }
    });

    return {
        Chapter: Chapter,
        ChapterCollection: ChapterCollection
    };

});