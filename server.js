const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

const app = express();
require("dotenv").config();

app.use(cors());

AWS.config.update({
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
	sessionToken: process.env.AWS_SESSION_TOKEN,
	region: "ap-southeast-2",
});

const s3 = new AWS.S3();
const sqs = new AWS.SQS();

const myBucket = "n10755888-cloud-bucket";
const sqsQueueUrl = process.env.SQS_QUEUE_URL;

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
	fs.mkdirSync(uploadDir);
}

const fileTypes = /video\/(mp4|mpeg|ogg|webm|3gp|mov|avi|wmv|mkv|flv)/;

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

// Helper function to upload to S3
const s3Upload = (file, bucketName) => {
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
					resolve(data.Location);
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
	async (req, res) => {
		const files = req.files;

		if (!files.video1 || !files.video2) {
			return res.status(400).send("Please upload two files.");
		}

		try {
			// Upload both videos to S3
			const video1Url = await s3Upload(files.video1[0], myBucket);
			const video2Url = await s3Upload(files.video2[0], myBucket);

			// Generate a unique ID for this job
			const jobId = uuidv4();

			// Send a message to SQS with the details for the processing worker
			const messageBody = JSON.stringify({
				jobId,
				video1Path: video1Url,
				video2Path: video2Url,
				audioOption: req.body.audioOption,
				layoutOption: req.body.layoutOption,
			});

			const sqsParams = {
				MessageBody: messageBody,
				QueueUrl: sqsQueueUrl,
			};

			await sqs.sendMessage(sqsParams).promise();

			res.send({
				message: "Files uploaded and processing started",
				jobId: jobId,
			});
		} catch (err) {
			console.error("Error: ", err);
			res.status(500).send(err.message);
		}
	},
	(error, req, res, next) => {
		if (error) {
			return res.status(400).send(error.message);
		}
	}
);

app.get("/status/:jobId", (req, res) => {
	const jobId = req.params.jobId;
	// Get the status of the job from your storage (database, in-memory, etc.)
	const job = getJobStatus(jobId);

	if (job && job.status === "completed") {
		res.json({ status: "completed", url: job.url });
	} else {
		res.json({ status: "processing" });
	}
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server is running on http://localhost:${port}`);
});
