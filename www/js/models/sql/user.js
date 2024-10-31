/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

// Model file for user-related classes:
// - user: contains authentication / authorization info
// - UserPreferences: contains editor / UI settings (this used to be stored in localStorage)
// - Bookmark: contains per-user placeholder info (last adapted XXX) settings, previously in the Project table
define(function (require) {

    "use strict";

    var $       = require('jquery'),
    Backbone    = require('backbone'),
    users = [],
    wordSpacingEnum = {
        NONE: 0,
        SMALL: 1,
        NORMAL: 2,
        WIDE: 3
    },

    // authenticate user
    signIn = function(username, password) {

    },

    // add / create user
    signUp = function (username, email, password) {

    },

    findById = function (searchKey) {
        var deferred = $.Deferred();
        var results = users.filter(function (element) {
            return element.attributes.userid === searchKey;
        });
        deferred.resolve(results);
        return deferred.promise();
    },
    
    User = Backbone.Model.extend({
        defaults: {
            username: "",
            userid: "",
            // email: "",
            // password: "",
            roles: [],
            copysource: 0,
            wrapusfm: 0,
            stopatboundaries: 0,
            alloweditblanksp: 0,
            showtranslationchecks: 0,
            defaultfttarget: 0,
            uilang: 0,
            darkmode: 1,
            bookmarks: [],
            wordspacing: wordSpacingEnum.NORMAL
        },
        initialize: function () {
            this.on('change', this.save, this);
        },
        fetch: function () {
            var deferred = $.Deferred();
            var obj = this;
            window.Application.db.transaction(function (tx) {
                tx.executeSql("SELECT * from user WHERE username=?;", [obj.attributes.username], function (tx, res) {
                    console.log("SELECT ok: " + res.rows);
                    obj.set(res.rows.item(0));
                    deferred.resolve(obj);
                });
            }, function (err) {
                console.log("SELECT error: " + err.message);
                deferred.reject(err);
            });
            return deferred.promise();
        },
        create: function () {
            var attributes = this.attributes;
            var sql = "INSERT INTO user (username, userid, roles, copysource, wrapusfm, stopatboundaries, alloweditblanksp, showtranslationchecks, defaultfttarget, uilang, darkmode, bookmarks, wordspacing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?);";
            window.Application.db.transaction(function (tx) {
                tx.executeSql(sql, [attributes.username, attributes.userid, attributes.roles, attributes.copysource, attributes.wrapusfm, attributes.stopatboundaries, attributes.alloweditblanksp, attributes.showtranslationchecks, attributes.defaultfttarget, attributes.uilang, attributes.darkmode, attributes.bookmarks, attributes.wordspacing], function (tx, res) {
                    console.log("INSERT ok: " + res.toString());
                }, function (tx, err) {
                    console.log("INSERT (create) error: " + err.message);
                });
            });
        },
        update: function () {
            var attributes = this.attributes;
            var sql = "UPDATE user SET username=?, roles=? copysource=?, wrapusfm=?, stopatboundaries=?, alloweditblanksp=?, showtranslationchecks=?, defaultfttarget=?, uilang=?, darkmode=?, bookmarks=?, wordspacing=? WHERE userid=?;";
            window.Application.db.transaction(function (tx) {
                tx.executeSql(sql, [attributes.username, attributes.roles, attributes.copysource, attributes.wrapusfm, attributes.stopatboundaries, attributes.alloweditblanksp, attributes.showtranslationchecks, attributes.defaultfttarget, attributes.uilang, attributes.darkmode, attributes.bookmarks, attributes.wordspacing, attributes.userid], function (tx, res) {
                    console.log("UPDATE ok: " + res.toString());
                }, function (tx, err) {
                    console.log("UPDATE error: " + err.message);
                });
            });
        },
        
        sync: function (method, model, options) {
            switch (method) {
                case 'create':
                    model.create();
                    break;
                        
                case 'read':
                    findById(this.userid).done(function (data) {
                        options.success(data);
                    });
                    break;
                        
                case 'update':
                    model.update();
                    break;
                        
                case 'delete':
                    model.destroy(options);
                    break;
            }
        }
    });

    UserCollection = Backbone.Collection.extend({
        model: User,

        resetFromDB: function () {
            var deferred = $.Deferred(),
                i = 0,
                len = 0;

            window.Application.db.transaction(function (tx) {
                tx.executeSql('CREATE TABLE IF NOT EXISTS user (id integer primary key, username text, userid text, roles text, CopySource integer, WrapUSFM integer, StopAtBoundaries integer, AllowEditBlankSP integer, ShowTranslationChecks integer, DefaultFTTarget integer, UILang integer, DarkMode integer, bookmarks Text, WordSpacing integer);');
                tx.executeSql("SELECT * from user;", [], function (tx, res) {
                    var tmpString = "";
                    for (i = 0, len = res.rows.length; i < len; ++i) {
                        // add the user
                        var user = new User();
                        user.off("change");
                        user.set(res.rows.item(i));
                        // convert text strings back into an array objects
                        tmpString = user.get('roles');
                        user.set('roles', JSON.parse(tmpString));
                        tmpString = user.get('bookmarks');
                        user.set('bookmarks', JSON.parse(tmpString));
                        users.push(user);
                        user.on("change", user.save, user);
                    }
                    console.log("SELECT ok: " + res.rows.length + " user items");
                });
            }, function (e) {
                deferred.reject(e);
            }, function () {
                deferred.resolve();
            });
            return deferred.promise();
        },
        
        initialize: function () {
            return this.resetFromDB();
        },

        // Removes all chapters from the collection (and database)
        clearAll: function () {
            window.Application.db.transaction(function (tx) {
                tx.executeSql('DELETE from user;'); // clear out the table
                users.length = 0; // delete local copy
            }, function (err) {
                console.log("DELETE error: " + err.message);
            });
        },

        sync: function (method, model, options) {
            if (method === "read") {
                if (options.data.hasOwnProperty('userid')) {
                    findById(options.data.userid).done(function (data) {
                        options.success(data);
                    });
                } else if (options.data.hasOwnProperty('username')) {
                    var deferred = $.Deferred();
                    var username = options.data.username;
                    var len = 0;
                    var i = 0;
                    var retValue = null;
                    // special case -- empty name query ==> reset local copy so we force a retrieve
                    // from the database
                    if (username === "") {
                        users.length = 0;
                    }
                    var results = users.filter(function (element) {
                        return element.attributes.username === username;
                    });
                    if (results.length === 0) {
                        // not in collection -- retrieve them from the db
                        window.Application.db.transaction(function (tx) {
                            tx.executeSql("SELECT * FROM user;", [], function (tx, res) {
                                var tmpString = "";
                                // populate the chapter collection with the query results
                                for (i = 0, len = res.rows.length; i < len; ++i) {
                                    // add the book
                                    var user = new User();
                                    user.off("change");
                                    user.set(res.rows.item(i));
                                    // convert text strings back into an array objects
                                    tmpString = user.get('roles');
                                    user.set('roles', JSON.parse(tmpString));
                                    tmpString = user.get('bookmarks');
                                    user.set('bookmarks', JSON.parse(tmpString));
                                    users.push(user);
                                    user.on("change", user.save, user);
                                }
                                // return the filtered results (now that we have them)
                                retValue = users.filter(function (element) {
                                    return element.attributes.username === username;
                                });
                                options.success(retValue);
                                deferred.resolve(retValue);
                            });
                        }, function (e) {
                            options.error();
                            deferred.reject(e);
                        });
                    } else {
                        // results already in collection -- return them
                        options.success(results);
                        deferred.resolve(results);
                    }
                    // return the promise
                    return deferred.promise();
                }
            }
        }
    });

    // Represents a placeholder in a project (book, chapter, and source phrase location). Can be more than 1 per user.
    Bookmark = Backbone.Model.extend({
        defaults: {
            bookmarkid: "",
            projectid: "",
            bookname: "",
            bookid: 0,
            chapterid: 0,
            spid: ""
        },
        
        initialize: function () {
            this.on('change', this.save, this);
        },
        fetch: function () {
            var deferred = $.Deferred();
            var obj = this;
            window.Application.db.transaction(function (tx) {
                tx.executeSql("SELECT * from bookmark WHERE bookmarkid=?;", [obj.attributes.bookmarkid], function (tx, res) {
                    console.log("SELECT ok: " + res.rows);
                    obj.set(res.rows.item(0));
                    deferred.resolve(obj);
                });
            }, function (err) {
                console.log("SELECT error: " + err.message);
                deferred.reject(err);
            });
            return deferred.promise();
        },
        create: function () {
            var attributes = this.attributes;
            var sql = "INSERT INTO bookmark (bookmarkid, bookname, bookid, chapterid, spid) VALUES (?,?,?,?,?);";
            window.Application.db.transaction(function (tx) {
                tx.executeSql(sql, [attributes.bookmarkid, attributes.bookname, attributes.bookid, attributes.chapterid, attributes.spid], function (tx, res) {
                    console.log("INSERT ok: " + res.toString());
                }, function (tx, err) {
                    console.log("INSERT (create) error: " + err.message);
                });
            });
        },
        update: function () {
            var attributes = this.attributes;
            var sql = "UPDATE bookmark SET bookname=?, bookid=?, chapterid=?, spid=? WHERE bookmarkid=?;";
            window.Application.db.transaction(function (tx) {
                //JSON.stringify(attributes.chapters)
                tx.executeSql(sql, [attributes.bookname, attributes.bookid, attributes.chapterid, attributes.spid, attributes.bookmarkid], function (tx, res) {
                    console.log("UPDATE ok: " + res.toString());
                }, function (tx, err) {
                    console.log("UPDATE error: " + err.message);
                });
            });
        },

        sync: function (method, model, options) {

            switch (method) {
            case 'create':
                options.success(model);
                break;
                    
            case 'read':
                options.success(data);
                break;
                    
            case 'update':
                options.success(model);
                break;
                    
            case 'delete':
                options.success(model);
                break;
            }
        }
    });

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