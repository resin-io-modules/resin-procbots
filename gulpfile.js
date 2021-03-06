const gulp = require('gulp');
const gutil = require('gulp-util');
const typescript = require('gulp-typescript');
const sourcemaps = require('gulp-sourcemaps');
const tslint = require('gulp-tslint');
const tsProject = typescript.createProject('tsconfig.json');
const exec = require('child_process').exec;

// Compile the TS sources
gulp.task('typescript', () => {
	return tsProject.src()
		.pipe(sourcemaps.init())
		.pipe(tsProject()).on('error', (err) => {
			throw err;
		})
		.pipe(sourcemaps.write('./', { includeContent: true,
			sourceRoot: '../lib'
		}))
		.pipe(gulp.dest('build/'));
});

gulp.task('tslint', () => {
	return tsProject.src()
		.pipe(tslint({
			configuration: 'tslint.json',
			formatter: 'prose'
		}))
		.pipe(tslint.report())
});

gulp.task('typedoc', (done) => {
	exec('`npm bin`/typedoc --name "Resin ProcBots" --module commonjs --target ES6 --excludeExternals ' +
		'--gitRevision master --media docresources --out docs/ lib/', () => {
			exec('touch docs/.nojekyll');
			done();
		});

});

gulp.task('build', [ 'tslint', 'typescript', 'typedoc' ]);
