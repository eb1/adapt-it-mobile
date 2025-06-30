// Gulpfile for Adapt It Mobile builds
var fs = require("fs"),
    path = require("path"),
    cp = require('node:child_process'),
    terser = require("gulp-terser"),
    del = require("del"),
    log = require("fancy-log"),
    cordova = require("cordova-lib").cordova;

const { series, parallel } = require('gulp');
const { src, dest } = require('gulp');

const paths = {
    js_src: './www/js/**/*',
    js_src_files: './www/js/***/*.js',
    js_dest: './www/js',
    js_bak: './www_js_bak'
};

// --- Minification Tasks ---

// Backup the original JS files to a temporary directory
function backup_js() {
    log('Backing up js files to ' + paths.js_bak + '\n');
    return src(paths.js_src).pipe(dest(paths.js_bak));
};

// Minify JS files in place for the build
function minify_js() {
    log('Calling terser on js files\n');
    return src(paths.js_src_files).pipe(terser()).pipe(dest(paths.js_dest));
};

// Restore the original JS files from backup
function restore_js() {
    log('** Restoring js files from ' + paths.js_bak + '\n');
    return del.deleteAsync([paths.js_dest]).then(() => {
        return src(paths.js_bak + '/**/*').pipe(dest(paths.js_dest));
    });
};

// Clean up the backup folder
function clean_backup() {
    log('** Cleaning backup files\n');
    return del.deleteAsync([paths.js_bak]);
};

// prep the Android platform -- either add it or clean it
function prep_android_dir (done) {
    var path = "./platforms/android";
    if (!fs.existsSync(path)) {
        log('Android dir not detected -- creating platform android\n');
        var cmd = cp.spawn('cordova', ["platform", "add", "android"], {stdio: 'inherit'}).on('exit', done);
    } else {
        log('cleaning platform android\n');
        var cmd = cp.spawn('cordova', ["clean", "android"], {stdio: 'inherit'}).on('exit', done);
    }
};

// prep the iOS platform -- either add it or clean it
function prep_ios_dir (done) {
    var path = "./platforms/ios";
    if (!fs.existsSync(path)) {
        log('ios dir not detected -- creating platform ios\n');
        var cmd = cp.spawn('cordova', ["platform", "add", "ios@latest"], {stdio: 'inherit'}).on('exit', done);
    } else {
        log('cleaning platform ios\n');
        var cmd = cp.spawn('cordova', ["clean", "ios"], {stdio: 'inherit'}).on('exit', done);
    }
};

// --- Main Build Tasks ---

// Cordova call
function do_build (platform, target, cb) {
    log('** Building for ' + platform + '\n');
    const cordovaBuild = (cb) => {
        let options = { platforms: [platform] };
        if (platform === 'android') {
            options.options = {
                argv: [target, "--verbose", "--buildConfig=build.json", "--gradleArg=--no-daemon"]
            };
        } else if (platform === 'ios') {
            options.options = {
                argv: [target, "--verbose", "--buildConfig=build.json", "--device"]
            };
        }
        cordova.build(options, cb);
    };

    cordovaBuild((err) => {
        if (err) return cb(err);
        cb();
    });
};

// copy over release .apk
function copyAndroidArtifact() {
    // Copy results to bin folder
    return src("platforms/android/app/build/outputs/apk/release/*.apk").pipe(dest("bin/release/android"));
};

function build_ios(done) {
    do_build('ios', '--release');
    done();
};

function build_android(done) {
    do_build('android', '--release');
    done();
}

function build_android_debug(done) {
    do_build('android', '--debug');
    done();
}

// --- Exported API / Visible to command line ---

// build both Android and iOS
exports.build = series(
    parallel(prep_android_dir, prep_ios_dir),
    backup_js,
    minify_js,
    parallel(build_android, build_ios),
    restore_js,
    clean_backup,
    copyAndroidArtifact
);
// ios (release)
exports.ios = series(
    prep_ios_dir,
    backup_js,
    minify_js,
    build_ios,
    restore_js,
    clean_backup,
);
// Android (release)
exports.android = series(
    prep_android_dir,
    backup_js,
    minify_js,
    build_android, 
    restore_js,
    clean_backup,
    copyAndroidArtifact
);
// CI build (Android debug)
exports.ci_build = series(
    prep_android_dir,
    backup_js,
    minify_js,
    build_android_debug, 
    restore_js,
    clean_backup,
    copyAndroidArtifact
);
// default (gulp / no args) is CI build
exports.default = this.ci_build;