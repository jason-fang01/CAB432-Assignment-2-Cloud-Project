const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const app = express();

// Create the uploads and outputs directories if they don't exist
const uploadDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "outputs");

if (!fs.existsSync(uploadDir)) {
	fs.mkdirSync(uploadDir);
}

if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir);
}

// Specify where uploaded files will be stored
const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		cb(null, "uploads/"); // Make sure this uploads directory exists
	},
	filename: function (req, file, cb) {
		cb(null, file.fieldname + "-" + Date.now() + ".mp4");
	},
});

const upload = multer({ storage: storage });

app.get("/", (req, res) => {
	res.sendFile(__dirname + "/index.html");
});

// Upload video endpoint
app.post(
	"/upload",
	upload.fields([{ name: "video1" }, { name: "video2" }]),
	(req, res) => {
		const files = req.files;
		const audioOption = req.body.audioOption; // Get the audio option from the request body

		if (!files.video1 || !files.video2) {
			return res.status(400).send("Please upload two files.");
		}

		const video1Path = files.video1[0].path;
		const video2Path = files.video2[0].path;
		const outputPath = path.join(outputDir, Date.now() + "-merged.mp4");

		// Choose FFmpeg command based on audio option
		let ffmpegCommand;
		switch (audioOption) {
			case "audio1":
				ffmpegCommand = `ffmpeg -i "${video1Path}" -i "${video2Path}" -filter_complex "[0:v]scale=1080:960,setsar=1[top];[1:v]scale=1080:960,setsar=1[bottom];[top][bottom]vstack=inputs=2[v]" -map "[v]" -map 0:a -c:a aac "${outputPath}"`;
				break;
			case "audio2":
				ffmpegCommand = `ffmpeg -i "${video1Path}" -i "${video2Path}" -filter_complex "[0:v]scale=1080:960,setsar=1[top];[1:v]scale=1080:960,setsar=1[bottom];[top][bottom]vstack=inputs=2[v]" -map "[v]" -map 1:a -c:a aac "${outputPath}"`;
				break;
			case "audioBoth":
				ffmpegCommand = `ffmpeg -i "${video1Path}" -i "${video2Path}" -filter_complex "[0:v]scale=1080:960,setsar=1[top];[1:v]scale=1080:960,setsar=1[bottom];[top][bottom]vstack=inputs=2[v];[0:a][1:a]amix=inputs=2[a]" -map "[v]" -map "[a]" -c:a aac "${outputPath}"`;
				break;
			default:
				return res.status(400).send("Invalid audio option selected.");
		}

		// Execute the FFmpeg command
		exec(ffmpegCommand, (err, stdout, stderr) => {
			if (err) {
				console.error("Error executing ffmpeg: ", err);
				return res.status(500).send(err.message);
			}

			console.log("FFmpeg stdout:\n", stdout);
			if (stderr) console.log("FFmpeg stderr:\n", stderr);

			res.send({
				message: "Files uploaded and processed",
				output: outputPath,
			});
		});
	}
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server is running on http://localhost:${port}`);
});
