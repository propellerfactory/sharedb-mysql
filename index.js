
/* 	MySQL-backed ShareDB (https://github.com/share/sharedb) database
*	Wraps https://www.npmjs.com/package/mysql
*	@author Win Min Tun (sawrochelais@gmail.com)
*	@version 1.0.0
*/

// @TODO: add support for MySQL JSON type
var DB = require('sharedb').DB;
var mysql = require('mysql');

var pool;
var mysql_config;

var ops_table;
var snapshots_table;
var debug = false;
	
// options = { db: { host: 'localhost', user: 'root', password: '', database: 'somedb', connectionLimit: 10 }, ops_table: 'ops_table_name', snapshots_table: 'snapshots_table_name', debug: false }
// connectionLimit [default=10], debug [default=false], ops_table[default=ops], snapshots[default=snapshots] are optional
function MySQLDB(options) {
	if (!(this instanceof MySQLDB)) return new MySQLDB(options);
	DB.call(this, options);

	this.closed = false;

	mysql_config = options.db;

	// connections in pool
	mysql_config.connectionLimit = options.db.connectionLimit ? options.connectionLimit : 10;
	  
	pool  = mysql.createPool(mysql_config);
	
	if (options.debug) {
		debug = options.debug;
		pool.on('acquire', function (connection) {
			console.log('Connection %d acquired', connection.threadId);
		});

		pool.on('release', function (connection) {
			console.log('Connection %d released', connection.threadId);
		});
			
		pool.on('enqueue', function () {
			console.log('Waiting for available connection slot');
		});
	}
	
	ops_table = options.ops_table ? options.ops_table : 'ops';
	snapshots_table = options.snapshots_table ? options.snapshots_table : 'snapshots';
	

};
module.exports = MySQLDB;

MySQLDB.prototype = Object.create(DB.prototype);

MySQLDB.prototype.close = function(callback) {
	this.closed = true;
	if (callback) callback();
};

function rollback(client, done) {
	client.query('ROLLBACK', function(err) {
		return done(err);
	})
}

// Persists an op and snapshot if it is for the next version. Calls back with
// callback(err, succeeded)
MySQLDB.prototype.commit = (collection, id, op, snapshot, options, callback) => {

	// get a connection from pool
	pool.getConnection((error, connection) => {
		
		if (error) {
			if (debug) console.log(error);
			connection.release();
			callback(error);
			return;
		}
		
		let max_version;
		
		let getMaxVersion = new Promise((resolve, reject) => {
			
			// Get max version no from operation for the document		
			connection.query('SELECT max(version) AS max_version FROM `'+ops_table+'` WHERE `collection` = ? AND `doc_id` = ?', [collection, id], (error, results, fields) => {
				// error will be an Error if one occurred during the query 
				// results will contain the results of the query 
				// fields will contain information about the returned results fields (if any)
					
				if (error) { reject(error); /*return;*/ };
							
				max_version = results[0].max_version;
				if (max_version == null) {
					max_version = 0;
				}
				if (snapshot.v !== max_version + 1) {
					reject(null);
					//return;
				}
						
			});		 
		});
		
		let insertOps_Snapshots = new Promise((resolve, reject) => {
			
			// transaction begins
			connection.beginTransaction((error) => {		
				if (error) {
					if (debug) console.log(error);
					connection.release();
					callback(error);
					return;
				}
				connection.query('INSERT INTO `'+ops_table+'` (collection, doc_id, version, operation) VALUES (?, ?, ?, ?)', [collection, id, snapshot.v, JSON.stringify(op)], (error, results, fields) => {
					if (error) {
						/*return*/ connection.rollback(() => {
							reject(error);
						});
					}
					
					if (snapshot.v === 1) {
						
						connection.query('INSERT INTO `'+snapshots_table+'` (collection, doc_id, doc_type, version, data) VALUES (?, ?, ?, ?, ?)', [collection, id, snapshot.type, snapshot.v, JSON.stringify(snapshot.data)], (error, results, fields) => {
							if (error) {
								/*return*/ connection.rollback(() => {
									reject(error);
								});
							}
							
							// commit
							connection.commit(function(error) {
								if (error) {
									/*return*/ connection.rollback(function() {
										reject(error);
									});
								} 
								connection.release();
								callback(null, true);
							});
						});
						
					} else {
						
						connection.query('UPDATE `'+snapshots_table+'` SET doc_type = ?, version = ?, data = ? WHERE collection = ? AND doc_id = ? AND version = (? - 1)', [snapshot.type, snapshot.v, JSON.stringify(snapshot.data), collection, id, snapshot.v], (error, results, fields) => {
							if (error) {
								/*return*/ connection.rollback(() => {
									reject(error);
								});
							}
							
							// commit
							connection.commit(function(error) {
								if (error) {
									/*return*/ connection.rollback(function() {
										reject(error);
									});
								} 
								connection.release();
								callback(null, true);
							});
						});
						
					}
					
					
					
				});
					
			});
				 
		});
		
		Promise.all([getMaxVersion, insertOps_Snapshots]).catch((error) => {
			if (debug) console.log(error);
			connection.release(); // release connection b4 error thrown
			
			if (error) {
				callback(error);				
			} else {
				callback(null, false);
			}			
		});
			
		
	});

};


// Get the named document from the database. The callback is called with (err,
// snapshot). A snapshot with a version of zero is returned if the docuemnt
// has never been created in the database.
MySQLDB.prototype.getSnapshot = function(collection, id, fields, options, callback) {
	
	// get a connection from pool
	pool.getConnection((error, connection) => {
		
		if (error) {
			if (debug) console.log(error);
			connection.release();
			callback(error);
			return;
		}
		
		connection.query('SELECT version, data, doc_type FROM `'+snapshots_table+'` WHERE collection = ? AND doc_id = ? LIMIT 1', [collection, id], (error, results, fields) => {

			if (error) {
				if (debug) console.log(error);
				connection.release();
				callback(error);
				return;
			}
			
			if (results.length) {
				let row = results[0]
				let snapshot = new MySQLSnapshot(
					id,
					row.version,
					row.doc_type,
					JSON.parse(row.data),
					undefined // TODO: metadata
				)
				callback(null, snapshot);
			} else {
				let snapshot = new MySQLSnapshot(
					id,
					0,
					null,
					undefined,
					undefined
				)
				callback(null, snapshot);
			}
			
			connection.release(); // release connection
				
		});
	});

};

// Get operations between [from, to) noninclusively. (Ie, the range should
// contain start but not end).
//
// If end is null, this function should return all operations from start onwards.
//
// The operations that getOps returns don't need to have a version: field.
// The version will be inferred from the parameters if it is missing.
//
// Callback should be called as callback(error, [list of ops]);
MySQLDB.prototype.getOps = function(collection, id, from, to, options, callback) {
	
	// get a connection from pool
	pool.getConnection((error, connection) => {

		if (error) {
			if (debug) console.log(error);
			connection.release();
			callback(error);
			return;
		}
		
		connection.query('SELECT version, operation FROM `'+ops_table+'` WHERE collection = ? AND doc_id = ? AND version >= ? AND version < ?', [collection, id, from, to], (error, results, fields) => {
			if (error) {
				if (debug) console.log(error);
				connection.release();
				callback(error);
				return;
			}
			callback(null, results.map(function(row) {
				return JSON.parse(row.operation);
			}));
			
			connection.release(); // release connection
		});
		
	});

};

function MySQLSnapshot(id, version, type, data, meta) {
  this.id = id;
  this.v = version;
  this.type = type;
  this.data = data;
  this.m = meta;
}