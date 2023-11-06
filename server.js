const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const app = express();

require("dotenv").config();

app.use(cors());

const AWS = require("aws-sdk");

AWS.config.update({
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
	sessionToken: process.env.AWS_SESSION_TOKEN,
	region: "ap-southeast-2",
});

// Create S3 service object using default configuration
const s3 = new AWS.S3();

const myBucket = "n10755888-cloud-bucket";

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
const fileTypes = /video\/(mp4|mpeg|ogg|webm|3gp|mov|avi|wmv|mkv|flv)/; // Regex to match allowed video mime types

const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		cb(null, "uploads/");
	},
	filename: function (req, file, cb) {
		cb(
			null,
			file.fieldname + "-" + Date.now() + path.extname(file.originalname)
		);
	},
});

const fileFilter = (req, file, cb) => {
	if (fileTypes.test(file.mimetype)) {
		cb(null, true);
	} else {
		cb(new Error("Unsupported file type!"), false);
	}
};

const upload = multer({ storage: storage, fileFilter: fileFilter });

const s3Upload = (file, bucketName) => {
	// Returns a promise that resolves with the URL of the uploaded file
	return new Promise((resolve, reject) => {
		fs.readFile(file.path, (err, data) => {
			if (err) {
				reject(err);
			}
			const params = {
				Bucket: bucketName,
				Key: path.basename(file.path),
				Body: data,
				ACL: "public-read",
			};
			s3.upload(params, (s3Err, data) => {
				if (s3Err) {
					console.error("Error in S3 upload: ", s3Err);
					reject(s3Err);
				} else {
					console.log("S3 upload response data: ", data);
					if (data && data.Location) {
						resolve(data.Location); // The file URL
					} else {
						reject(new Error("Upload did not return a location"));
					}
				}
			});
		});
	});
};

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

		const layoutOption = req.body.layoutOption; // Get the layout option from the request body

		// Choose the FFmpeg filter based on the layout option
		let filterComplex;
		if (layoutOption === "horizontal") {
			// For horizontal split, scale each video to half of 1080 width (which is 540) but keep the 1920 height
			filterComplex =
				"[0:v]scale=1080:960,setsar=1[top];[1:v]scale=1080:960,setsar=1[bottom];[top][bottom]vstack=inputs=2[v]";
		} else {
			// Default to vertical if no layoutOption is specified or if it's 'vertical'
			// For vertical split, scale each video to full 1080 width but half of 1920 height (which is 960)
			filterComplex =
				"[0:v]scale=540:1920,setsar=1[left];[1:v]scale=540:1920,setsar=1[right];[left][right]hstack=inputs=2[v]";
		}

		// Choose FFmpeg command based on audio option
		switch (req.body.audioOption) {
			case "audio1":
				ffmpegCommand = `ffmpeg -i "${video1Path}" -i "${video2Path}" -filter_complex "${filterComplex}" -map "[v]" -map 0:a -c:a aac "${outputPath}"`;
				break;
			case "audio2":
				ffmpegCommand = `ffmpeg -i "${video1Path}" -i "${video2Path}" -filter_complex "${filterComplex}" -map "[v]" -map 1:a -c:a aac "${outputPath}"`;
				break;
			case "audioBoth":
				ffmpegCommand = `ffmpeg -i "${video1Path}" -i "${video2Path}" -filter_complex "${filterComplex};[0:a][1:a]amix=inputs=2[a]" -map "[v]" -map "[a]" -c:a aac "${outputPath}"`;
				break;
			default:
				return res.status(400).send("Invalid audio option selected.");
		}

		// Execute the FFmpeg command
		exec(ffmpegCommand, async (err, stdout, stderr) => {
			if (err) {
				console.error("Error executing ffmpeg: ", err);
				return res.status(500).send(err.message);
			}

			console.log("FFmpeg stdout:\n", stdout);
			if (stderr) console.log("FFmpeg stderr:\n", stderr);

			// After FFmpeg has successfully processed the video
			try {
				// Upload the output file to S3
				const s3Response = await s3Upload(
					{ path: outputPath },
					myBucket
				);

				// After uploading, send the S3 file URL in the response
				res.send({
					message: "Files uploaded and processed",
					output: s3Response, // This is the URL to access the file on S3
				});

				// Delete the local files
				fs.unlinkSync(outputPath);
				fs.unlinkSync(video1Path);
				fs.unlinkSync(video2Path);
			} catch (uploadErr) {
				console.error("Error uploading file: ", uploadErr);
				return res.status(500).send(uploadErr.message);
			}
		});
	},
	(error, req, res, next) => {
		// Error handling middleware
		if (error) {
			return res.status(400).send(error.message);
		}
	}
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server is running on http://localhost:${port}`);
});
