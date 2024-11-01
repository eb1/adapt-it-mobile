/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

define(function (require) {

    "use strict";

    var Backbone = require('backbone'),

    wordSpacingEnum = {
        NONE: 0,
        SMALL: 1,
        NORMAL: 2,
        WIDE: 3
    },

    User = Backbone.Model.extend({
        urlRoot: '/users',
        // default values
        defaults: {
            username: "", // must be unique
            userid: "",
            // password: "",
            roles: [],
            bookmarks: [],
            // editor preferences (in local storage for pre-v1.18)
            copysource: 0,
            wrapusfm: 0,
            stopatboundaries: 0,
            alloweditblanksp: 0,
            showtranslationchecks: 0,
            defaultfttarget: 0,
            uilang: 0,
            darkmode: 1,
            wordspacing: wordSpacingEnum.NORMAL
        },

    }),

    UserCollection = Backbone.Collection.extend({
        model: User,
        url: "/users"
    }),

    // Represents a placeholder in a project (book, chapter, and source phrase location). Can be more than 1 per user.
    Bookmark = Backbone.Model.extend({
        urlRoot: '/bookmarks',
        defaults: {
            bookmarkid: "",
            projectid: "",
            bookname: "",
            bookid: 0,
            chapterid: 0,
            spid: ""
        }
    }),

    BookmarkCollection = Backbone.Collection.extend({
        model: Bookmark,
        url: "/bookmarks"
    });

    return {
        User: User,
        UserCollection: UserCollection,
        Bookmark: Bookmark,
        BookmarkCollection: BookmarkCollection
    };

});