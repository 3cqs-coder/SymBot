db.createUser({
  user: "symbot",
  pwd: "symbot123",
  roles: [ { role: "dbOwner", db: "symbot" } ]
})

db.users.insert({
  name: "symbot"
})
