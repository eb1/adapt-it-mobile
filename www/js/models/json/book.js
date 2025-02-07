/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

define(function (require) {

    "use strict";

    var Backbone = require('backbone'),

    Book = Backbone.Model.extend({
        // default values
        defaults: {
            bookid: "",
            projectid: "",
            scrid: "",
            name: "",
            filename: "",
            chapters: []
        },

    }),

    BookCollection = Backbone.Collection.extend({
        model: Book,
        url: function() {
            // TODO: global function to prepend server:port to url path
            // return this.document.url() + '/books';
            return "http://localhost:3042/books";
        },
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
        Book: Book,
        BookCollection: BookCollection
    };

});