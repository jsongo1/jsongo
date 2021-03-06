import { fsDB } from "jsongo";

const db = fsDB("./db");
db.users.deleteMany({}); // truncate
db.users.insertMany([{ name: "guest" }, { name: "anonymous" }]);
db.save(); // write to fs

const users = db.users.find({});
for (const user of users) {
  console.log(user);
}
