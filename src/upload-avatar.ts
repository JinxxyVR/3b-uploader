import { Avatar, createAvatar, createFile, createFileVersion, finishFileUpload, getAvatar, showFile, startFileUpload, updateAvatar, VRChatError, VRChatMimeType } from "./api";
import { metadata } from "tauri-plugin-fs-extra-api";
import { extname } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api";
import upload from "./upload";
import { useState } from "react";
import { Bundle, ReadyBundles } from "./bundle";

const md5DigestFile = (path: string) => invoke('md5_digest_file', { path }) as Promise<string>;
const signatureGenerateFromFile = (path: string, output: string, fake?: boolean) => invoke('signature_generate_from_file', { path, output }) as Promise<void>;

type Platform = "windows" | "android" | "ios";
type Progress = { type: "init" | "thumbnail" | "waiting" | "completed"; }
    | { type: "bundle", part: number, totalParts: number, platformIndex: number; totalPlatforms: number; }
    | { type: "error", msg: string; };

export function useUpload(bundle: Bundle, readyBundle: ReadyBundles) {
    const [progress, setProgress] = useState<Progress | null>(null);

    const uploading = progress !== null && progress.type !== "completed" && progress.type !== "error";

    const upload = async (authToken: string) => {
        try {
            setProgress({ type: "init" });
            const avatarId = bundle.metadata.blueprintId;

            let avatar: Avatar | null;
            // try and get avatar, if avatar exists for user, we have to update
            // TODO: prompt user to confirm upload (overwrite)
            try {
                avatar = await getAvatar(authToken, avatarId);
            } catch (err) {
                avatar = null;
            }
            setProgress({ type: "thumbnail" });
            const imageUrl = await uploadFileToVRChat(authToken, imageFileName(bundle.metadata.name), bundle.thumbnailPath, "image/png", (part, totalParts) => { });
            if (avatar) {
                await updateAvatar(authToken, avatarId, { name: bundle.metadata.name, imageUrl });
            } else {
                try {
                    avatar = await createAvatar(authToken, { id: avatarId, name: bundle.metadata.name, imageUrl, releaseStatus: "private", unityVersion: "2022.3.6f1" });
                } catch (err) {
                    if (err instanceof VRChatError &&
                        err.data.error.status_code === 500
                    ) {
                        throw new Error("Blueprint ID already in use: Avatar bundle has already been uploaded");
                    }
                    throw err;
                }
            }
            setProgress({ type: "waiting" });
            const totalPlatforms = Object.keys(bundle.metadata.assetBundles).length;
            let platformIndex = 0;
            for await (const { platform, path } of readyBundle()) {
                console.log("uploading: ", path);
                const unityPlatform = platform === "windows" ? "standalonewindows" : platform;
                const unityVersion = bundle.metadata.assetBundles[platform as Platform]!!.unityVersion;
                const avatarUrl = await uploadFileToVRChat(authToken, avatarFileName(bundle.metadata.name), path, "application/x-avatar", (part, totalParts) => {
                    setProgress({ type: "bundle", part, totalParts, platformIndex, totalPlatforms });
                });
                await updateAvatar(authToken, avatar.id, { assetUrl: avatarUrl, platform: unityPlatform, unityVersion: unityVersion, assetVersion: 1 });
                platformIndex++;
            }
            setProgress({ type: "completed" });
        } catch (err) {
            console.error(err);
            setProgress({ type: "error", msg: (err as Error).message });
        }
    };


    return { progress, uploading, upload };
}

// returns asssetUrl
async function uploadFileToVRChat(authToken: string, name: string, path: string, mimeType: VRChatMimeType, onProgress: (part: number, totalParts: number) => void) {
    const extension = "." + await extname(path);
    let file = await createFile(authToken, { name, mimeType, extension });

    const fileMd5 = await md5DigestFile(path);
    const fileMetadata = await metadata(path);

    const signaturePath = path + '.sig';
    await signatureGenerateFromFile(path, signaturePath);
    const signatureMd5 = await md5DigestFile(signaturePath);
    const signatureMetadata = await metadata(signaturePath);

    file = await createFileVersion(authToken, file.id, {
        signatureMd5,
        signatureSizeInBytes: signatureMetadata.size,
        fileMd5,
        fileSizeInBytes: fileMetadata.size
    });

    const uploadFile = async () => {
        if (file.versions[file.versions.length - 1].file!!.category === "multipart") {
            const partSize = 10 * 1024 * 1024;
            const maxParts = Math.ceil(fileMetadata.size / partSize);
            const etags = Array(maxParts);
            for (let partNumber = 1; partNumber <= maxParts; partNumber++) {
                onProgress(partNumber - 1, maxParts);
                const uploadPart = async () => {
                    const start = (partNumber - 1) * partSize;
                    const end = Math.min(partNumber * partSize, fileMetadata.size);
                    const length = end - start;
                    const { url } = await startFileUpload(authToken, file.id, 1, "file", partNumber);
                    const etag = await invoke("upload_file", { url, path, start, length }) as string;
                    if (etag) {
                        etags[partNumber - 1] = etag.replace(/^['"]|['"]$/g, '');
                    } else {
                        console.warn("no etag received");
                    }
                };
                await uploadPart();
            }
            await finishFileUpload(authToken, file.id, 1, "file", { etags });
            onProgress(maxParts, maxParts);
        } else {
            onProgress(0, 1);
            const { url } = await startFileUpload(authToken, file.id, 1, "file");
            const resp = await upload(url, path, undefined, new Map<string, string>([
                ["Content-Type", mimeType],
                ["Content-MD5", fileMd5]
            ]));
            await finishFileUpload(authToken, file.id, 1, "file");
            onProgress(1, 1);
        }
    };

    const uploadSig = async () => {
        const { url } = await startFileUpload(authToken, file.id, 1, "signature");
        const resp = await upload(url, signaturePath, undefined, new Map<string, string>([
            ["Content-Type", "application/x-rsync-signature"],
            ["Content-MD5", signatureMd5]
        ]));
        await finishFileUpload(authToken, file.id, 1, "signature");
    };

    await Promise.all([uploadFile(), uploadSig()]);

    const fileUploaded = await showFile(authToken, file.id);
    return fileUploaded.versions[fileUploaded.versions.length - 1].file!!.url;
}

const avatarFileName = (name: string) => `Avatar - ${name} - Asset bundle - 2022.3.6f1_1_standalonewindows_Release`;
const imageFileName = (name: string) => `Avatar - ${name} - Image - 2022.3.6f1_1_standalonewindows_Release`;

