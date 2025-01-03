import express from 'express';
import checkAuth from '../middlewares/authMiddleware.js';
import Candidate from '../models/candidate.js';
import Subject from '../models/subject.js';
import { safeHandler } from '../middlewares/safeHandler.js';
import ApiError from '../utils/errorClass.js';
import bcrypt from 'bcrypt';
import fs from 'fs';
import { generateToken, verifyToken } from '../utils/jwtFuncs.js';
import { candidateLoginSchema, candidateRegistrationSchema, candidateUpdateSchema } from '../utils/zodSchemas.js';
import path from 'path';
import config from '../config/config.js';
import getSelectedFields from '../utils/selectFields.js';
import { calculateAllExpertsScoresMultipleSubjects, calculateAverageRelevancyScoreSingleCandidate, calculateAverageScoresAllExperts, calculateSingleCandidateScoreMultipleSubjects } from '../utils/updateScores.js';
import Application from '../models/application.js';
import Expert from '../models/expert.js';
import { isValidObjectId } from 'mongoose';
import axios from 'axios';
const tempResumeFolder = config.paths.resume.temporary;
const candidateResumeFolder = config.paths.resume.candidate;

import { fileURLToPath } from 'url';
import { candidateImageUpload } from '../utils/multer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = express.Router();
// the rout / is being used to do crud of an candidate by admin or someone of  higher level
router.route('/')
    .get(checkAuth("admin"), safeHandler(async (req, res) => {
        const candidates = await Candidate.find().select("-password");
        if (!candidates || candidates.length === 0) {
            throw new ApiError(404, "No candidate was found", "NO_CANDIDATES_FOUND");
        }
        return res.success(200, "All candidates successfully retrieved", { candidates });
    }))

    .post(candidateImageUpload.single('image'), safeHandler(async (req, res) => {
        const fields = candidateRegistrationSchema.parse(req.body);
        // { name, email, password, mobileNo, dateOfBirth, education, skills, experience, linkedin, resumeToken, gender }

        const findArray = [
            { email: fields.email },
            { mobileNo: fields.mobileNo }
        ];
        if (fields.linkedIn) findArray.push({ linkedin: fields.linkedIn });

        const candidateExists = await Candidate.findOne({
            $or: findArray
        });

        if (candidateExists) {
            let existingField;

            if (candidateExists.email === fields.email) existingField = 'Email';
            else if (candidateExists.mobileNo === fields.mobileNo) existingField = 'Mobile number';
            else if (candidateExists.linkedIn && candidateExists.linkedin === fields.linkedin) existingField = 'Linkedin id';

            throw new ApiError(400, `Candidate already exists with this ${existingField}`, "CANDIDATE_ALREADY_EXISTS");
        }
        let newResumeName = null;

        if (fields.resumeToken) {
            try {
                const payload = verifyToken(fields.resumeToken);
                const resumeName = payload.resumeName;

                    newResumeName = `${fields.name.split(' ')[0]}_resume_${new Date().getTime()}.pdf`;

                    try {
                        axios.post(`${process.env.RESUME_UPLOAD_URL}/upload/resume/changename`, { newResumeName, oldResumeName: resumeName, person: "candidate" })
                    } catch (error) {
                        console.log("Error while sending resume token to other server", error)
                    }
                    fields.resume = newResumeName;
                
                delete fields.resumeToken; // try removing this if any error occurs
            } catch (error) {
                console.log("Error processing resume during registration", error);
            }
        }
        // uploading image here
        if (req.file) {
            const formData = new FormData();

            fields.image = `${fields.name.split(' ')[0]}_image_${new Date().getTime()}${path.extname(req.file.originalname)}`;

            const destinationFolder = path.join(__dirname, `../public/${config.paths.image.candidate}`);
            const newFilePath = path.join(destinationFolder, fields.image);
            await fs.promises.rename(req.file.path, newFilePath);

            formData.append("image", fs.createReadStream(newFilePath));

            await axios.post(`${process.env.RESUME_UPLOAD_URL}/upload/image/candidate`, formData,
                {
                    headers: {
                        ...formData.getHeaders()
                    }
                }
            )
            fs.promises.unlink(newFilePath);
        }

        fields.password = await bcrypt.hash(fields.password, 10);
        const candidate = await Candidate.create(fields);

        return res.success(201, "candidate successfully created", { candidate: { id: candidate._id, email: candidate.email, name: candidate.name } });
    }))

    .delete(checkAuth("admin"), safeHandler(async (req, res) => {
        const candidates = await Candidate.find().select("-password");
        if (!candidates || candidates.length === 0) {
            throw new ApiError(404, "No candidates found", "NO_CANDIDATES_FOUND");
        }
        await Candidate.deleteMany();
        console.log("Deleting all candidates", candidates)
        await Promise.all([
            Subject.updateMany({}, { $set: { applications: [], candidates: [] } }),
            (async () => {
                const folderPath = path.join(__dirname, `../public/${candidateResumeFolder}`);
                try {
                    await fs.promises.access(folderPath);
                    await fs.promises.rmdir(folderPath, { recursive: true });
                } catch (error) {
                    console.error(`Failed to remove directory: ${folderPath}`, error);
                }
            })(),
            Application.deleteMany(),
            Expert.updateMany({}, { $set: { applications: [] } }),
            // Add if remember more
        ]);
        res.success(200, "All candidates successfully deleted", { candidates });

        await calculateAllExpertsScoresMultipleSubjects(candidates.map(c => c.subjects).flat());
        await calculateAverageScoresAllExperts();

    }));

router.route('/:id')
    .get(checkAuth("candidate"), safeHandler(async (req, res) => {
        const { id } = req.params;
        if (!isValidObjectId(id)) throw new ApiError(400, "Invalid candidate ID", "INVALID_ID");
        const { education, experience } = req.query;

        const candidate = await Candidate.findById(id).select(getSelectedFields({ education, experience }));

        if (!candidate) {
            throw new ApiError(404, "Candidate not found", "CANDIDATE_NOT_FOUND");
        }
        return res.success(200, "Candidate found", { candidate });
    }))

    .patch(checkAuth("candidate"), safeHandler(async (req, res) => {
        const { id } = req.params;
        if (!isValidObjectId(id)) throw new ApiError(400, "Invalid candidate ID", "INVALID_ID");

        const updates = candidateUpdateSchema.parse(req.body);

        const filteredUpdates = Object.fromEntries(
            Object.entries(updates).filter(([_, value]) => value != null)
        );

        if (Object.keys(filteredUpdates).length === 0) {
            throw new ApiError(400, 'No updates provided', 'NO_UPDATES_PROVIDED');
        }

        const uniqueCheck = [];
        if (filteredUpdates.email) uniqueCheck.push({ email: filteredUpdates.email });
        if (filteredUpdates.mobileNo) uniqueCheck.push({ mobileNo: filteredUpdates.mobileNo });
        if (filteredUpdates.linkedin) uniqueCheck.push({ linkedin: filteredUpdates.linkedin });

        if (uniqueCheck.length > 0) {
            const candidateExists = await Candidate.findOne({
                $or: uniqueCheck
            });

            if (candidateExists && candidateExists._id.toString() !== id) {
                let existingField;

                if (candidateExists.email === filteredUpdates.email) existingField = 'Email';
                else if (candidateExists.mobileNo === filteredUpdates.mobileNo) existingField = 'Mobile number';
                else if (candidateExists.linkedIn && candidateExists.linkedin === filteredUpdates.linkedin) existingField = 'Linkedin id';

                throw new ApiError(400, `Candidate already exists with this ${existingField}`, "CANDIDATE_ALREADY_EXISTS");
            }
        }

        if (filteredUpdates.resumeToken) {
            try {
                const payload = verifyToken(filteredUpdates.resumeToken);
                const resumeName = payload.resumeName;
                const resumePath = path.join(__dirname, `../public/${tempResumeFolder}/${resumeName}`);

                const fileExists = await fs.promises.access(resumePath).then(() => true).catch(() => false);

                if (fileExists) {
                    const candidate = await Candidate.findById(id);
                    if (candidate?.resume) {
                        try {
                            await fs.promises.unlink(path.join(__dirname, `../public/${candidateResumeFolder}/${candidate.resume}`));
                        } catch (error) {
                            if (error.code === 'ENOENT') {
                                console.log('File does not exist');
                            } else {
                                console.error('An error occurred:', error);
                            }
                        }
                    }

                    const newResumeName = `${candidate.name.split(' ')[0]}_resume_${new Date().getTime()}.pdf`;
                    const destinationFolder = path.join(__dirname, `../public/${candidateResumeFolder}`);
                    const newFilePath = path.join(destinationFolder, newResumeName);
                    await fs.promises.mkdir(destinationFolder, { recursive: true });
                    await fs.promises.rename(resumePath, newFilePath);

                    filteredUpdates.resume = newResumeName;
                }
            } catch (error) {
                console.log("Error processing resume during update", error);
            }

            delete filteredUpdates.resumeToken;
        }

        if (filteredUpdates.password) {
            filteredUpdates.password = await bcrypt.hash(filteredUpdates.password, 10);
        }

        const candidate = await Candidate.findByIdAndUpdate(
            id,
            filteredUpdates,
            {
                new: true,
                runValidators: true
            }
        ).select("-password");

        if (!candidate) {
            throw new ApiError(404, "Candidate not found", "CANDIDATE_NOT_FOUND");
        }

        res.success(200, "Candidate updated successfully", { candidate });

        if (filteredUpdates.skills) {
            await Promise.all([calculateSingleCandidateScoreMultipleSubjects(candidate._id), calculateAllExpertsScoresMultipleSubjects(candidate.subjects)]);
            await Promise.all([calculateAverageRelevancyScoreSingleCandidate(candidate._id), calculateAverageScoresAllExperts()]);
        }
    }))

    .delete(checkAuth("admin"), safeHandler(async (req, res) => {
        const { id } = req.params;
        if (!isValidObjectId(id)) throw new ApiError(400, "Invalid candidate ID", "INVALID_ID");

        const candidate = await Candidate.findByIdAndDelete(id).select("-password");
        if (!candidate) {
            throw new ApiError(404, "Candidate not found", "CANDIDATE_NOT_FOUND");
        }
        try {
            await Promise.all([
                Subject.updateMany({ _id: { $in: candidate.subjects } }, { $pull: { candidates: { id: candidate._id } } }),
                Application.deleteMany({ candidate: candidate._id }),
                (async () => {
                    const filePath = path.join(__dirname, `../public/${candidateResumeFolder}/${candidate.resume}`);
                    try {
                        await fs.promises.access(filePath, fs.constants.F_OK);
                        await fs.promises.unlink(filePath);
                    } catch (error) {
                        if (error.code !== 'ENOENT') {
                            console.error(`Failed to delete file: ${filePath}`, error);
                        }
                    }
                })()
            ]);
        } catch (error) {
            console.error('Error occurred while deleting candidate', error);
        }

        res.success(200, "Candidate deleted successfully", { candidate });
        await calculateAllExpertsScoresMultipleSubjects(candidate.subjects);
        await calculateAverageScoresAllExperts();

    }));

router.post('/signin', safeHandler(async (req, res) => {
    const { email, password } = candidateLoginSchema.parse(req.body);
    const candidate = await Candidate.findOne({ email });
    if (!candidate) {
        throw new ApiError(404, "Invalid email or password", "INVALID_CREDENTIALS");
    }

    const validPassword = await bcrypt.compare(password, candidate.password);
    if (!validPassword) {
        throw new ApiError(404, "Invalid email or password", "INVALID_CREDENTIALS");
    }

    const userToken = generateToken({ id: candidate._id, role: "candidate" });
    res.cookie("userToken", userToken, { httpOnly: true });
    return res.success(200, "Successfully logged in", { userToken, candidate: { id: candidate._id, email: candidate.email, name: candidate.name }, role: "candidate" });
}));

export default router;
