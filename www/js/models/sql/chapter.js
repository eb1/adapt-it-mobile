/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */
define(function (require) {

    "use strict";

    var $           = require('jquery'),
        Backbone    = require('backbone'),
        chapters = [],

        findById = function (searchKey) {
            var deferred = $.Deferred();
            var results = chapters.filter(function (element) {
                return element.attributes.chapterid.toLowerCase().indexOf(searchKey.toLowerCase()) > -1;
            });
            deferred.resolve(results);
            return deferred.promise();
        },

        Chapter = Backbone.Model.extend({
            defaults: {
                chapterid: "",
                bookid: "",
                projectid: "",
                name: "",
                lastadapted: 0,
                versecount: 0
            },
            initialize: function () {
                // this.on('change', this.save, this);
            },
            fetch: function () {
                var deferred = $.Deferred();
                var obj = this;
                window.Application.db.transaction(function (tx) {
                    tx.executeSql("SELECT * from chapter WHERE chapterid=?;", [obj.attributes.chapterid], function (tx, res) {
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
                var sql = "INSERT INTO chapter (chapterid,bookid,projectid,name,lastadapted,versecount) VALUES (?,?,?,?,?,?);";
                window.Application.db.transaction(function (tx) {
                    tx.executeSql(sql, [attributes.chapterid, attributes.bookid, attributes.projectid, attributes.name, attributes.lastadapted, attributes.versecount], function (tx, res) {
                        // console.log ("** CHAPTER INSERT: " + attributes.name);
                        attributes.id = res.insertId;
//                        console.log("INSERT ok: " + res.toString());
                    }, function (tx, err) {
                        console.log("CHAPTER INSERT (create) error: " + err.message);
                    });
                });
            },
            update: function () {
                var attributes = this.attributes;
                var sql = 'UPDATE chapter SET bookid=?, projectid=?, name=?, lastadapted=?, versecount=? WHERE chapterid=?;';
                window.Application.db.transaction(function (tx) {
                    // console.log ("** CHAPTER UPDATE: " + attributes.name);
                    tx.executeSql(sql, [attributes.bookid, attributes.projectid, attributes.name, attributes.lastadapted, attributes.versecount, attributes.chapterid], function (tx, res) {
//                        console.log("UPDATE ok: " + res.toString());
                    }, function (tx, err) {
                        console.log("CHAPTER UPDATE error: " + err.message);
                    });
                });
            },
            destroy: function (options) {
                window.Application.db.transaction(function (tx) {
                    tx.executeSql("DELETE FROM chapter WHERE chapterid=?;", [this.attributes.chapterid], function (tx, res) {
//                        console.log("DELETE ok: " + res.toString());
                    }, function (tx, err) {
                        console.log("CHAPTER DELETE error: " + err.message);
                    });
                });
            },
            
            sync: function (method, model, options) {
                switch (method) {
                case 'create':
                    model.create();
                    break;
                        
                case 'read':
                    findById(this.id).done(function (data) {
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

        }),

        ChapterCollection = Backbone.Collection.extend({

            model: Chapter,

            resetFromDB: function () {
                var deferred = $.Deferred(),
                    i = 0,
                    len = 0;
                window.Application.db.transaction(function (tx) {
                    tx.executeSql('CREATE TABLE IF NOT EXISTS chapter (id integer primary key, chapterid text, bookid text, projectid text, name text, lastadapted integer, versecount integer);');
                    tx.executeSql("SELECT * from chapter;", [], function (tx, res) {
                        for (i = 0, len = res.rows.length; i < len; ++i) {
                            // add the chapter
                            var ch = new Chapter();
                            ch.off("change");
                            ch.set(res.rows.item(i));
                            chapters.push(ch);
                            ch.on("change", ch.save, ch);
                        }
                        console.log("SELECT ok: " + res.rows.length + " chapter items");
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
                    tx.executeSql('DELETE from chapter;', [], function (tx, res) {
                        console.log("chapter DELETE (all) ok.");
                        chapters.length = 0;
                    }, function (tx, err) {
                        console.log("chapter DELETE (all) error: " + err.message);
                    });
                }, function (err) {
                    console.log("DELETE error: " + err.message);
                });
            },

            sync: function (method, model, options) {
                var deferred = $.Deferred();
                var name = options.data.name;
                var len = 0;
                var i = 0;
                var retValue = null;
                var results = null;
                if (method === "read") {
                    if (options.data.hasOwnProperty('bookid')) {
                        // find bookid matches
                        var bookid = options.data.bookid;
                        results = chapters.filter(function (element) {
                            return element.attributes.bookid === bookid.toLowerCase();
                        });
                        // results already in collection -- return them
                        options.success(results);
                        deferred.resolve(results);
                    } else if (options.data.hasOwnProperty('projectid')) {
                        // find projectid matches
                        var projectid = options.data.projectid;
                        results = chapters.filter(function (element) {
                            return element.attributes.projectid === projectid;
                        });
                        // results already in collection -- return them
                        options.success(results);
                        deferred.resolve(results);
                    } else if (options.data.hasOwnProperty('name')) {
                        // special case -- empty name query ==> reset local copy so we force a retrieve
                        // from the database
                        if (name === "") {
                            chapters.length = 0;
                        }
                        results = chapters.filter(function (element) {
                            return element.attributes.name.toLowerCase().indexOf(name.toLowerCase()) > -1;
                        });
                        if (results.length === 0) {
                            // not in collection -- retrieve them from the db
                            window.Application.db.transaction(function (tx) {
                                tx.executeSql("SELECT * FROM chapter;", [], function (tx, res) {
                                    // populate the chapter collection with the query results
                                    for (i = 0, len = res.rows.length; i < len; ++i) {
                                        // add the chapter
                                        var ch = new Chapter();
                                        ch.off("change");
                                        ch.set(res.rows.item(i));
                                        chapters.push(ch);
                                        ch.on("change", ch.save, ch);
                                    }
                                    // return the filtered results (now that we have them)
                                    retValue = chapters.filter(function (element) {
                                        if (name.length > 0) {
                                            return element.attributes.name.toLowerCase().indexOf(name.toLowerCase()) > -1;
                                        } else {
                                            // cleared out the old collection -- now fetch everything
                                            return true;
                                        }
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
                    } else {
                        return Backbone.sync.apply(this, arguments);
                    }
                }
            }

        });

    return {
        Chapter: Chapter,
        ChapterCollection: ChapterCollection
    };

});