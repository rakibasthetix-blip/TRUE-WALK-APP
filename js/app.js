const express = require("express");

const app = express();
const PORT = 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("TRUE WALK Server is Running");
});

app.listen(PORT, () => {
  console.log(`TRUE WALK server running at http://localhost:${PORT}`);
});