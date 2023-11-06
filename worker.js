const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

AWS.config.update({
	accessKeyId: process.env.AWS_ACCESS_KEY_ID,
	secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
	sessionToken: process.env.AWS_SESSION_TOKEN,
	region: "ap-southeast-2",
});

const s3 = new AWS.S3();
const sqs = new AWS.SQS();
const sqsQueueUrl = process.env.SQS_QUEUE_URL;
const myBucket = "n10755888-cloud-bucket";

const outputDir = path.join(__dirname, "processed");

if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir);
}

const downloadFile = (fileUrl) => {
	return new Promise((resolve, reject) => {
		const fileName = path.basename(fileUrl);
		const filePath = path.join(__dirname, "uploads", fileName);

		const params = {
			Bucket: myBucket,
			Key: fileName,
		};

		const s3Stream = s3.getObject(params).createReadStream();
		const fileStream = fs.createWriteStream(filePath);

		s3Stream.on("error", reject);
		fileStream.on("error", reject);
		fileStream.on("close", () => resolve(filePath));
		s3Stream.pipe(fileStream);
	});
};

const s3Upload = (file) => {
	return new Promise((resolve, reject) => {
		fs.readFile(file, (err, data) => {
			if (err) reject(err);

			const params = {
				Bucket: myBucket,
				Key: uuidv4() + path.basename(file),
				Body: data,
				ACL: "public-read",
			};

			s3.upload(params, (s3Err, data) => {
				if (s3Err) reject(s3Err);
				else resolve(data.Location);
			});
		});
	});
};

const processVideo = async (message) => {
	const { jobId, video1Path, video2Path, audioOption, layoutOption } =
		JSON.parse(message.Body);

	const localVideo1Path = await downloadFile(video1Path);
	const localVideo2Path = await downloadFile(video2Path);
	const outputPath = path.join(outputDir, jobId + "-merged.mp4");

	// Choose the FFmpeg filter based on the layout option
	let filterComplex;
	if (layoutOption === "horizontal") {
		filterComplex =
			"[0:v]scale=1080:960,setsar=1[top];[1:v]scale=1080:960,setsar=1[bottom];[top][bottom]vstack=inputs=2[v]";
	} else {
		filterComplex =
			"[0:v]scale=540:1920,setsar=1[left];[1:v]scale=540:1920,setsar=1[right];[left][right]hstack=inputs=2[v]";
	}

	let ffmpegCommand;

	// Choose FFmpeg command based on audio option
	switch (audioOption) {
		case "audio1":
			ffmpegCommand = `ffmpeg -i "${localVideo1Path}" -i "${localVideo2Path}" -filter_complex "${filterComplex}" -map "[v]" -map 0:a -c:a aac "${outputPath}"`;
			break;
		case "audio2":
			ffmpegCommand = `ffmpeg -i "${localVideo1Path}" -i "${localVideo2Path}" -filter_complex "${filterComplex}" -map "[v]" -map 1:a -c:a aac "${outputPath}"`;
			break;
		case "audioBoth":
			ffmpegCommand = `ffmpeg -i "${localVideo1Path}" -i "${localVideo2Path}" -filter_complex "${filterComplex};[0:a][1:a]amix=inputs=2[a]" -map "[v]" -map "[a]" -c:a aac "${outputPath}"`;
			break;
		default:
			console.error("Invalid audio option selected.");
			return;
	}

	exec(ffmpegCommand, async (err, stdout, stderr) => {
		if (err) {
			console.error("Error executing ffmpeg: ", err);
		} else {
			console.log("FFmpeg stdout:\n", stdout);
			if (stderr) console.log("FFmpeg stderr:\n", stderr);

			try {
				const s3Response = await s3Upload(outputPath);
				console.log("File uploaded:", s3Response);

				// Clean up the local files
				fs.unlinkSync(outputPath);
				fs.unlinkSync(localVideo1Path);
				fs.unlinkSync(localVideo2Path);
			} catch (uploadErr) {
				console.error("Error uploading file: ", uploadErr);
			}
		}

		// Delete the message from the queue
		const deleteParams = {
			QueueUrl: sqsQueueUrl,
			ReceiptHandle: message.ReceiptHandle,
		};

		sqs.deleteMessage(deleteParams, (err, data) => {
			if (err) {
				console.error("Error deleting message from the queue", err);
			} else {
				console.log("Deleted message from queue", data);
			}
		});
	});
};

const pollQueue = () => {
	const params = {
		QueueUrl: sqsQueueUrl,
		MaxNumberOfMessages: 1,
		VisibilityTimeout: 60,
	};

	sqs.receiveMessage(params, (err, data) => {
		if (err) {
			console.error("Receive Error", err);
		} else if (data.Messages) {
			data.Messages.forEach((message) => processVideo(message));
		}
	});
};

setInterval(pollQueue, 100); // Poll every 1 seconds
