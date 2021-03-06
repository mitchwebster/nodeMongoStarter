var express = require('express');
var request = require('request');
var bodyParser = require('body-parser');
var async = require('async');
var time = require('time');
var http = require('http');
var path = require('path');
var Promise = require('promise');
var MongoClient = require('mongodb').MongoClient;
var dbConfig = require('./dbConfig');
var util = require('./util');

var portNumber = 8080;
var app = express();
app.use(bodyParser.json())

console.log('Listening on port ', portNumber);

app.use("/", express.static("public"));

app.get("/", function (req, res) {
	res.sendFile(path.resolve('./public/views/index.html'));
});

MongoClient.connect(dbConfig.url, function(err, db) {
	if (err) {
		console.log("Could not connect to the database");
		console.log(err);
		app.listen(portNumber);
	} else {
		//setup indicies for DB
		db.collection('Courses').createIndex({"crn": 1, "term": -1}, {unique: true, unique: true});
		db.collection('Users').createIndex({"username": 1, "term": -1}, {unique: true, unique: true});
		db.collection('Attendance').createIndex({"username": 1, "crn": 1, "time": 1, "term": -1}, {unique: true, unique: true, unique: true, unique: true});
		db.collection('Requests').createIndex({"username": 1, "crn": 1, "mistakeDate": 1, "term": -1}, {unique: true, unique: true, unique: true, unique: true});

		//routes
		// app.post('/api/test', function(req, res) {
		// 	// res.send({err : false, msg: "API is online"});
		// 	findUser(req.body.username).done(function (result) {
  //               console.log(result);
  //               res.send(result);
  //           }, function (failure) {
  //               console.log(failure);
  //               res.send(failure);
  //           });
		// });

		//Post request to find courses for a given user
		//requried params: username (string)
		app.post('/api/myCourses', function(req, res) {
			if (!req.body || !util.validate(req.body.username)) {
				res.send({err : true, msg: "Invalid username"})
			} else {
				//find the given user
				util.findUser(req.body.username, db).done(function (userObject) {
					//gind the courses for this user
	                util.findCourseObjects(userObject.crns, db, time).done(function (courseObjects) {
	                	//successfully got the course objects
	                	res.send({err : false,  userExists: true, courses: courseObjects, instructor: userObject.instructor});
	                }, function (failure) {
	                	//some issue with course objects
	                	console.log(failure);
	                	res.send({err : true, msg: "Invalid Request"});
	                });
	            }, function (failure) {
	            	//no user found
	                console.log(failure);
	                res.send({err : false, userExists: false, courses: []});
	            });
			}
		});

		//post request to find the course sections for a set of tsquare labels
		//requried params: courses [String]
		app.post('/api/coursePrompt', function(req, res) {
			if (!req.body || !req.body.courses || !req.body.courses.length || req.body.courses.length <= 0) {
				res.send({err : true, msg: "Invalid request"})
			}
			var asyncCalls = [];
			var out_titles = [];
			//parse each of the course titles to check their validity
			req.body.courses.forEach(function (element, index, titles) {
				var curTitle = util.parseCourseTitle(element);
				if (curTitle !== null) {
					out_titles.push(curTitle);
				}
			});
			//for each of the course titles, asynchronously hit the util lookup (which will either hit the db or go to coursesat)
			out_titles.forEach(function (element, index, titles) {
				asyncCalls.push(function (callback) {
					util.lookupCourse(element.school, element.courseNumber, db).done(function (result) {
		                callback(null, result);
		            }, function (failure) {
		                callback(null, failure);
		            });
				});
			});
			//once we return from async calls check their validity
			async.parallel(asyncCalls, function(err, results) {
				var output = {};
				for (var i = 0; i < results.length; i++) {
					if (results[i] !== "Failed HTTP Request" && results[i] !== "Failed Parsing" && results[i] !== "Not JSON") {
						for (var j = 0; j < results[i].length; j++) {
							//if the response is valid add the course objects to an output array
							//ensure that we combine sections for the same class
							if (results[i][j].courseName in output) {
								output[results[i][j].courseName].push({section: results[i][j].section, crn: results[i][j].crn, valid: results[i][j].valid});
							} else {
								output[results[i][j].courseName] = [{section: results[i][j].section, crn: results[i][j].crn, valid: results[i][j].valid}];
							}
						}
					}
				}
				//reformat the array and send it
				courseObjects = [];
				keys = Object.keys(output);
				for (var i = 0; i < keys.length; i++) {
					courseObjects.push({courseName: keys[i], sections: output[keys[i]]});
				}
				res.send({err : false, courses: courseObjects})
			});
		});

		//post request to create a user if they do not already exist
		//requried params: username (string), courses [String] (these are crns)
		app.post('/api/userSetup', function(req, res) {
			if (!req.body || !util.validate(req.body.username) || !req.body.courses || !req.body.courses.length || req.body.courses.length <= 0) {
				res.send({err : true, msg: "Invalid request"})
			} else {
				//make sure the crns are valid, in the future we may want to check that these are in the DB
				var validatedCRNS = []
				for (var i = 0; i < req.body.courses.length; i++) {
					var x = util.validate(req.body.courses[i], "int");
					if (x) {
						validatedCRNS.push(x);
					}
				}
				var user = {
					"username" : req.body.username,
					"term" : util.findTerm(),
					"crns" : validatedCRNS,
					"instructor" : false
				};
				//send the user to the db
				db.collection('Users').insert(user, {w:1}, function(err, result) {
					if (err) {
						res.send({err : true, msg: "Invalid Request"});
					} else {
						res.send({err : false, msg: "Created User"});
					}
				});
			}
		});

		//post request to create an instructor
		//requried params: username (string), courses [String] (these are crns)
		//TODO: may want to break this function into util and pass in whether they are an instructor or not
		app.post('/api/instructorSetup', function(req, res) {
			if (!req.body || !util.validate(req.body.username) || !req.body.courses || !req.body.courses.length || req.body.courses.length <= 0) {
				res.send({err : true, msg: "Invalid request"})
			} else {
				//essentially the same procedure as user setup but now we set the instructor to true
				var validatedCRNS = []
				for (var i = 0; i < req.body.courses.length; i++) {
					var x = util.validate(req.body.courses[i], "int");
					if (x) {
						validatedCRNS.push(x);
					}
				}
				var user = {
					"username" : req.body.username,
					"term" : util.findTerm(),
					"crns" : validatedCRNS,
					"instructor" : true
				};
				db.collection('Users').insert(user, {w:1}, function(err, result) {
					if (err) {
						res.send({err : true, msg: "Invalid Request"});
					} else {
						res.send({err : false, msg: "Created User"});
					}
				});
			}
		});

		//post request to get the roster of students
		//requried params: username (string), crn (string)
		app.post('/api/course/roster', function(req, res) {
				if (!req.body) {
					res.send({err : true, msg: "Invalid request"});
				} else {
					var username = util.validate(req.body.username);
					var crn = util.validate(req.body.crn, "int");
					if (!username || !crn) {
						res.send({err : true, msg: "Invalid request"});
					} else {
						//find the user and verify they are an instructor for the given course
						util.findUser(req.body.username, db).done(function (userObject) {
							if (userObject.instructor && userObject.crns.indexOf(crn) >= 0) {
								//find the students for the given course
								util.findStudents(userObject.crns, db, time).done(function (rosterData) {
				                	res.send({err : false,  roster: rosterData});
				                }, function (failure) {
				                	console.log(failure);
				                	res.send({err : true, msg: "Invalid Request"});
				                });
							} else {
			                	res.send({err : true, msg: "Invalid Permissions"});
							}
			            }, function (failure) {
			            	//no user found
			                console.log(failure);
			                res.send({err : true, msg: "Invalid Permissions"});
			            });
					}
				}
		});
		
		//Post to checkin: creating an attendance record for a given user
		//requried params: username (string), crn (string), routerLocation (string), pastDate (String) (optional), instructor (string)
		app.post('/api/checkin', function(req, res) {
			if (!req.body) {
				res.send({err : true, msg: "Invalid request"});
			} else {
				var username = util.validate(req.body.username);
				var crn = util.validate(req.body.crn, "int");
				var rLoc = util.validate(req.body.routerLocation);
				var term = util.findTerm();
				var pastDate = util.validate(req.body.pastDate, "date");
				var instructor = util.validate(req.body.instructor);
				if (!username || !crn) {
					res.send({err : true, msg: "Invalid request"});
				} else {
					//if past date is sent in the request, then this is an instructor editing the attendance data
					if (pastDate && instructor) {
						util.findUser(instructor, db).done(function (userObject) {
							//verify that the isntructor is for a given course
							if (userObject.instructor && userObject.crns.indexOf(crn) >= 0) {
								//if it all checks out then add the attendance record
								util.createAttendanceRecord(username, crn, rLoc, pastDate, db, time).done(function (rosterData) {
				                	res.send({err : false});
				                }, function (failure) {
				                	console.log(failure);
				                	res.send({err : true, msg: "Invalid Request"});
				                });
							} else {
			                	res.send({err : true, msg: "Invalid Permissions"});
							}
			            }, function (failure) {
			            	//no user found
			                console.log(failure);
			                res.send({err : true, msg: "Invalid Permissions"});
			            });
					} else if (rLoc) {
						//this is the student requesting to checkin, so lets try to create an attendance record (this function will do the verifciations)
						util.createAttendanceRecord(username, crn, rLoc, null, db, time).done(function (rosterData) {
		                	res.send({err : false});
		                }, function (failure) {
		                	console.log(failure);
		                	res.send({err : true, msg: "Invalid Request"});
		                });
					} else {
						res.send({err : true, msg: "Invalid request"});
					}
				}
			}
		});

		//post request to get all of the attendance records for a given user during the current term
		//requried params: username (string), crn (string) (optional)
		app.post('/api/attendanceData', function(req, res) {
			if (!req.body || !util.validate(req.body.username)) {
				res.send({err : true, msg: "Invalid username"})
			} else {
				var usrname = req.body.username;
				var course = util.validate(req.body.crn, "int");
				//query based on username alone
				if (course === null) {
					db.collection('Attendance').find({"username" : usrname, "term": util.findTerm()}, {"time": true, "_id": false}).toArray(function(err, data) {
						if (err) {
							res.send({err : true, msg: "Database issue"});
						} else {
							res.send({err : false, attendance: data});
						}
					});
				} else {
					//query based on username and course number
					db.collection('Attendance').find({"username" : usrname, "crn": course, "term": util.findTerm()}, {"time": true, "_id": false}).toArray(function(err, data) {
						if (err) {
							res.send({err : true, msg: "Database issue"});
						} else {
							res.send({err : false, attendance: data});
						}
					});
				}
			}
		});

		//get request to retrieve a random location, used for demo purposes while RNOC api is not available
		app.get('/api/mock/locationData', function(req, res) {
			var locations = [
				"Klaus 1456",
				"Skiles 368",
				"Howey L2",
				"U A Whitaker Biomedical Engr 1103",
				"Instruction Center 219"
			];
			res.send({location: locations[Math.floor(Math.random() * locations.length)]});
		});

		//post request to get a summary of the attendance records for a given course
		//requried params: username (string), crn (string)
		app.post('/api/course/summary', function(req, res) {
				if (!req.body) {
					res.send({err : true, msg: "Invalid request"});
				} else {
					var username = util.validate(req.body.username);
					var crn = util.validate(req.body.crn, "int");
					if (!username || !crn) {
						res.send({err : true, msg: "Invalid request"});
					} else {
						util.findUser(req.body.username, db).done(function (userObject) {
							if (userObject.instructor && userObject.crns.indexOf(crn) >= 0) {
								//if the user is an instructor for the given course then go look for all of the attendance records for all students in this course
								db.collection('Attendance').find({"crn": crn, "term": util.findTerm()}, {"username": true, "time": true, "_id": false}).toArray(function(err, data) {
									if (err) {
										res.send({err : true, msg: "Database issue"});
									} else {
										var students = {};
										var accumulatedAttendance = {}; //total attendance by date
										//go through the attendance records
										for (var i = 0; i < data.length; i++) {
											//keep track of the per student record
											if (data[i].username in students) {
												students[data[i].username] += 1;
											} else {
												students[data[i].username] = 1;
											}
											//group all the attendance records for a given date
											var d = new Date(data[i].time);
											d = util.dateToMonthDayYear(d);
											var dateString = d.toString();
											if (dateString in accumulatedAttendance) {
												accumulatedAttendance[dateString] += 1;
											} else {
												accumulatedAttendance[dateString] = 1;
											}
										}
										res.send({err : false, studentData: students, attendanceData: accumulatedAttendance});
									}
								});
							} else {
			                	res.send({err : true, msg: "Invalid Permissions"});
							}
			            }, function (failure) {
			            	//no user found
			                console.log(failure);
			                res.send({err : true, msg: "Invalid Permissions"});
			            });
					}
				}
		});

		//post request to create a request for attendance record for a given date
		//requried params: username (string), crn (string), mistakeDate(string)
		app.post('/api/request/create', function(req, res) {
			if (!req.body) {
				res.send({err : true, msg: "Invalid request"});
			} else {
				var username = util.validate(req.body.username);
				var crn = util.validate(req.body.crn, "int");
				var term = util.findTerm();
				var mistakeDate = util.validate(req.body.mistakeDate, "date");
				if (!username || !crn || !mistakeDate) {
					res.send({err : true, msg: "Invalid request"});
				} else {
					util.findUser(username, db).done(function (userObject) {
						if (userObject.crns.indexOf(crn) >= 0) {
							var startEnd = util.oneDayRange(mistakeDate);
							//try to conver the date to a range of one day
							if (startEnd) {
								var requestObject = {
									"username" : username,
									"crn" : crn,
									"term": term,
									"mistakeDate" : startEnd.start
								};
								//if it is valid then insert it in the db
								db.collection('Requests').insert(requestObject, {w:1}, function(err, result) {
									if (err) {
										res.send({err : true, msg: "Unable to complete the request"});
									} else {
										res.send({err : false, msg: "Success"});
									}
								});
							} else {
								res.send({err: true, msg: "Unable to submit request at given time"});
							}
						} else {
		                	res.send({err : true, msg: "Invalid Permissions"});
						}
		            }, function (failure) {
		            	//no user found
		                console.log(failure);
		                res.send({err : true, msg: "Invalid Permissions"});
		            });
				}
			}
		});

		//post request to view all of the requests for attendance regarding a given student
		//requried params: username (string), crn (string)
		app.post('/api/request/view', function(req, res) {
			if (!req.body) {
				res.send({err : true, msg: "Invalid request"});
			} else {
				var username = util.validate(req.body.username);
				var crn = util.validate(req.body.crn, "int");
				var term = util.findTerm();
				if (!username || !crn) {
					res.send({err : true, msg: "Invalid request"});
				} else {
					util.findUser(username, db).done(function (userObject) {
						if (userObject.crns.indexOf(crn) >= 0) {
							//if the user is an instructor then get all of the requests for the course
							if (userObject.instructor) {
								db.collection('Requests').find({"crn": crn, "term": util.findTerm()}, {"username": true, "crn": true, "term" : true, "mistakeDate": true, "_id": false}).toArray(function(err, data) {
									if (err) {
										res.send({err : true, msg: "Database issue"});
									} else {
										res.send({err : false, requests: data});
									}
								});
							} else {
								//if the user is not an instructor, only get their specific requests
								db.collection('Requests').find({"username" : username, "crn": crn, "term": util.findTerm()}, {"username": true, "crn": true, "term" : true, "mistakeDate": true, "_id": false}).toArray(function(err, data) {
									if (err) {
										res.send({err : true, msg: "Database issue"});
									} else {
										res.send({err : false, requests: data});
									}
								});
							}
						} else {
		                	res.send({err : true, msg: "Invalid Permissions"});
						}
		            }, function (failure) {
		            	//no user found
		                console.log(failure);
		                res.send({err : true, msg: "Invalid Permissions"});
		            });
				}
			}
		});

		//post request to remove request for attendance from the database and the user and instructor
		//requried params: username (string), instructor (string), crn (string), mistakeDate (string)
		app.post('/api/request/remove', function(req, res) {
			if (!req.body) {
				res.send({err : true, msg: "Invalid request"});
			} else {
				var username = util.validate(req.body.username);
				var instructor = util.validate(req.body.instructor);
				var crn = util.validate(req.body.crn, "int");
				var mistakeDate = util.validate(req.body.mistakeDate, "date");
				if (!username || !crn || !mistakeDate) {
					res.send({err : true, msg: "Invalid request"});
				} else {
					util.findUser(username, db).done(function (userObject) {
						if (userObject.crns.indexOf(crn) >= 0) {
							//go and find this specific request and delte it from the db
							util.removeRequest(username, crn, mistakeDate, db).done(function (userObject) {
								res.send({err : false, msg: "Successfully removed request"});
				            }, function (failure) {
				            	//no user found
				                console.log(failure);
				                res.send({err : true, msg: failure});
				            });
						} else {
		                	res.send({err : true, msg: "Invalid Permissions"});
						}
		            }, function (failure) {
		            	//no user found
		                console.log(failure);
		                res.send({err : true, msg: "Invalid Permissions"});
		            });
				}
			}
		});

		//post request to accept a request for attendance, effectively adding an attendance record at a given date
		//requried params: username (string), instructor (string), crn (string), mistakeDate (string)
		app.post('/api/request/accept', function(req, res) {
			if (!req.body) {
				res.send({err : true, msg: "Invalid request"});
			} else {
				var username = util.validate(req.body.username);
				var instructor = util.validate(req.body.instructor);
				var crn = util.validate(req.body.crn, "int");
				var term = util.findTerm();
				var mistakeDate = util.validate(req.body.mistakeDate, "date");
				if (!username || !crn || !mistakeDate) {
					res.send({err : true, msg: "Invalid request"});
				} else {
					util.findUser(instructor, db).done(function (userObject) {
						if (userObject.crns.indexOf(crn) >= 0) {
							if (userObject.instructor) {
								//if the user is an instructor then create an attendance record for the student
								util.createAttendanceRecord(username, crn, "", mistakeDate, db, time).done(function (rosterData) {
									//then remove the request
				                	util.removeRequest(username, crn, mistakeDate, db).done(function (userObject) {
										res.send({err : false, msg: "Successfully accepted request"});
						            }, function (failure) {
						                console.log(failure);
						                res.send({err : true, msg: "Invalid Request Acceptance"});
						            });
				                }, function (failure) {
				                	console.log(failure);
				                	res.send({err : true, msg: "Invalid Request"});
				                });
							} else {
								res.send({err : true, msg: "Invalid Permissions"});
							}
						} else {
		                	res.send({err : true, msg: "Invalid Permissions"});
						}
		            }, function (failure) {
		            	//no user found
		                console.log(failure);
		                res.send({err : true, msg: "Invalid Permissions"});
		            });
				}
			}
		});

		app.listen(portNumber);
	}
});