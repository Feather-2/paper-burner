// process/main.js

/**
 * 处理单个 PDF 文件或 Markdown/TXT 文件的核心函数。
 * 该函数封装了从文件上传、OCR（如果需要）、内容提取、分段翻译（如果需要）、
 * 错误处理到结果保存的完整流程。
 *
 * 主要流程：
 * 1. **初始化与日志**：
 *    - 记录文件处理开始的日志，包括文件名、类型和使用的 API Key 信息（部分屏蔽）。
 * 2. **文件类型判断与内容提取**：
 *    - **PDF 文件**：
 *      - 检查 Mistral API Key 是否提供，未提供则抛出错误。
 *      - 调用 `uploadToMistral` 上传文件。
 *      - 调用 `getMistralSignedUrl` 获取签名 URL。
 *      - 调用 `callMistralOcr` 进行 OCR 处理。
 *      - 调用 `processOcrResults` (如果可用) 处理 OCR 结果，提取 Markdown 内容和图片数据。
 *      - 捕获 OCR 过程中的错误，特别是 API Key 失效的错误 (如401)，如果发生则返回特定错误对象，以便上层进行 Key 失效处理。
 *    - **MD/TXT 文件**：
 *      - 直接读取文件文本内容作为 Markdown 内容，图片数据为空。
 *      - 捕获文件读取错误。
 *    - **不支持的文件类型**：抛出错误。
 * 3. **翻译流程** (如果 `selectedTranslationModelName` 不是 'none')：
 *    - 检查翻译 API Key 是否提供，未提供则记录警告，翻译内容标记为未翻译。
 *    - **估算 Token 数与分段判断**：
 *      - 使用 `estimateTokenCount` (如果可用) 估算 Markdown 内容的 token 数。
 *      - 如果 token 数超过 `tokenLimit * 1.1`，则判断为长文档，调用 `translateLongDocument` (如果可用) 进行分段翻译。
 *        `translateLongDocument` 内部会处理表格保护、并发控制、自定义模型配置和重试逻辑。
 *      - 否则，判断为短文档，直接调用 `translateMarkdown` (如果可用) 进行单块翻译。
 *        在调用 `translateMarkdown` 前后通过 `acquireSlot` 和 `releaseSlot` 控制并发。
 *    - **错误处理**：
 *      - 捕获翻译过程中的错误，特别是 API Key 失效的错误。如果发生，返回特定错误对象以便上层处理。
 *      - 其他翻译错误，则将翻译内容标记为失败，但保留 OCR 结果（如果成功）。
 * 4. **结果保存**：
 *    - 调用 `saveResultToDB` (如果可用) 将处理结果（包括原文、译文、图片、分块信息）保存到 IndexedDB。
 * 5. **成功回调**：
 *    - 调用 `onFileSuccess` 回调函数，通知上层该文件处理成功。
 * 6. **返回结果对象**：
 *    - 返回一个包含处理结果的对象，包括 `file`, `markdown`, `translation`, `images`, `ocrChunks`, `translatedChunks` 和 `error` (成功时为 `null`)。
 *    - 如果发生可识别的 Key 失效，`keyInvalid` 字段会被设置。
 * 7. **异常捕获 (Final Catch)**：
 *    - 捕获整个流程中未被特定逻辑捕获的严重错误，记录日志，并返回包含错误信息的对象。
 * 8. **资源清理 (Finally Block)**：
 *    - 如果是 PDF 文件且成功上传到 Mistral，则调用 `deleteMistralFile` 清理在 Mistral 服务器上的临时文件。
 *    - 捕获并记录清理过程中的潜在错误。
 *
 * @param {File} fileToProcess - 待处理的 PDF、Markdown 或 TXT 文件对象。
 * @param {Object | null} mistralKeyObject - Mistral API Key 对象，包含 `id` 和 `value`，或为 `null`。
 * @param {Object | null} translationKeyObject - 选定翻译模型对应的 API Key 对象，包含 `id` 和 `value`，或为 `null`。
 * @param {string} selectedTranslationModelName - 选定的翻译模型名称 (如 'deepseek', 'custom', 'none')。
 * @param {Object | null} translationModelConfig - 当 `selectedTranslationModelName` 为 'custom' 时，提供自定义模型的配置对象。
 * @param {number} maxTokensPerChunkValue - (用于长文档翻译) 每个翻译分块的最大 token 限制。
 * @param {string} targetLanguageValue - 目标翻译语言代码 (如 'zh-CN', 'en')。
 * @param {function} acquireSlot - 用于获取并发执行槽位的函数。
 * @param {function} releaseSlot - 用于释放并发执行槽位的函数。
 * @param {string} defaultSystemPromptSetting - 翻译时使用的默认系统提示词。
 * @param {string} defaultUserPromptTemplateSetting - 翻译时使用的默认用户提示词模板。
 * @param {boolean} useCustomPromptsSetting - 是否使用用户自定义的提示词。
 * @param {function} onFileSuccess - 单个文件处理成功后的回调函数，参数为成功处理的 `File` 对象。
 * @returns {Promise<Object>} 一个包含处理结果的对象。成功时结构如：
 *   `{ file, markdown, translation, images, ocrChunks, translatedChunks, error: null }`。
 *   失败或 Key 失效时，`error` 字段会有错误信息，`keyInvalid` 字段可能被设置。
 */
async function processSinglePdf(
    fileToProcess,
    mistralKeyObject,
    translationKeyObject,
    selectedTranslationModelName,
    translationModelConfig,
    maxTokensPerChunkValue,
    targetLanguageValue,
    acquireSlot,
    releaseSlot,
    defaultSystemPromptSetting,
    defaultUserPromptTemplateSetting,
    useCustomPromptsSetting, // 新增参数
    onFileSuccess
) {
    let currentMarkdownContent = '';
    let currentTranslationContent = '';
    let currentImagesData = [];
    let mistralFileId = null; // 重命名 fileId to mistralFileId for clarity
    const logPrefix = `[${fileToProcess.name}]`;
    const fileType = fileToProcess.name.split('.').pop().toLowerCase();
    let ocrChunks = [];
    let translatedChunks = [];
    // 移除旧的内部重试和key切换逻辑，这些将由 app.js 处理

    console.log('processSinglePdf: translationKeyObject', translationKeyObject);

    try {
        const mistralKeyValue = mistralKeyObject ? mistralKeyObject.value : null;
        if (typeof addProgressLog === "function") {
            addProgressLog(`${logPrefix} 开始处理 (类型: ${fileType}, Mistral Key: ...${mistralKeyValue ? mistralKeyValue.slice(-4) : 'N/A'})`);
        }

        if (fileType === 'pdf') {
            if (!mistralKeyValue) {
                throw new Error('处理 PDF 文件需要 Mistral API Key，但未提供。');
            }
            try {
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 上传到 Mistral...`);
                mistralFileId = await uploadToMistral(fileToProcess, mistralKeyValue);
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 上传成功, File ID: ${mistralFileId}`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // 短暂等待，确保文件在Mistral端准备好
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 获取签名 URL...`);
                const signedUrl = await getMistralSignedUrl(mistralFileId, mistralKeyValue);
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 成功获取 URL，开始 OCR 处理...`);
                const ocrData = await callMistralOcr(signedUrl, mistralKeyValue);
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} OCR 完成，处理 OCR 结果...`);

                if (typeof processOcrResults !== 'function') {
                    throw new Error('processOcrResults函数未定义，无法处理OCR结果');
                }
                const processedOcr = processOcrResults(ocrData);
                currentMarkdownContent = processedOcr.markdown;
                currentImagesData = processedOcr.images;
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} Markdown 生成完成`);
            } catch (error) {
                // 判断是否为 Mistral Key 失效错误
                if (error.message && (error.message.includes('无效') || error.message.includes('未授权') || error.message.includes('401') || error.message.toLowerCase().includes('invalid api key') || error.message.toLowerCase().includes('unauthorized'))) {
                    if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} Mistral API Key (...${mistralKeyValue.slice(-4)}) 可能已失效: ${error.message}`);
                    return {
                        file: fileToProcess,
                        keyInvalid: {
                            type: 'mistral',
                            keyIdToInvalidate: mistralKeyObject.id
                        },
                        error: `Mistral Key 失效: ${error.message}`
                    };
                }
                throw error; // 其他类型的OCR错误，向上抛出由 app.js 的常规重试处理
            }
        } else if (fileType === 'md' || fileType === 'txt') {
            if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 读取 ${fileType.toUpperCase()} 文件内容...`);
            try {
                currentMarkdownContent = await fileToProcess.text();
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} ${fileType.toUpperCase()} 文件内容读取完成`);
                currentImagesData = [];
            } catch (readError) {
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 读取 ${fileType.toUpperCase()} 文件失败: ${readError.message}`);
                throw new Error(`读取 ${fileType.toUpperCase()} 文件失败: ${readError.message}`);
            }
        } else {
            throw new Error(`不支持的文件类型: ${fileType}`);
        }

        // --- 翻译流程 (如果需要) ---
        if (selectedTranslationModelName !== 'none') {
            const translationKeyValue = translationKeyObject ? translationKeyObject.value : null;
            if (!translationKeyValue) {
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 警告: 需要翻译但未提供有效的翻译 API Key。跳过翻译。`);
                currentTranslationContent = '[未翻译：缺少API Key]';
                ocrChunks = [currentMarkdownContent];
                translatedChunks = [currentTranslationContent];
            } else {
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 开始翻译 (${selectedTranslationModelName}, Key: ...${translationKeyValue.slice(-4)})`);

                if (typeof estimateTokenCount !== 'function') throw new Error('estimateTokenCount函数未定义');
                const estimatedTokens = estimateTokenCount(currentMarkdownContent);
                const tokenLimit = parseInt(maxTokensPerChunkValue) || 2000;

                try {
                    if (estimatedTokens > tokenLimit * 1.1) {
                        if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 文档较大 (~${Math.round(estimatedTokens/1000)}K tokens), 分段翻译`);
                        if (typeof translateLongDocument !== 'function') throw new Error('translateLongDocument函数未定义');

                        console.log('main.js 调用 translateLongDocument 参数:', {
                            useCustomPromptsSetting,
                            defaultUserPromptTemplateSetting,
                            defaultSystemPromptSetting,
                            translationModelConfig,
                            currentMarkdownContent,
                            targetLanguageValue,
                            selectedTranslationModelName,
                            translationKeyValue,
                            tokenLimit,
                            logPrefix
                        });
                        let translationResult;
                        if (selectedTranslationModelName === 'custom') {
                            translationResult = await translateLongDocument(
                                currentMarkdownContent,
                                targetLanguageValue,
                                selectedTranslationModelName,
                                translationKeyValue,
                                translationModelConfig,
                                tokenLimit,
                                acquireSlot,
                                releaseSlot,
                                logPrefix,
                                defaultSystemPromptSetting,
                                defaultUserPromptTemplateSetting,
                                useCustomPromptsSetting
                            );
                        } else {
                            translationResult = await translateLongDocument(
                                currentMarkdownContent,
                                targetLanguageValue,
                                selectedTranslationModelName,
                                translationKeyValue,
                                tokenLimit,
                                acquireSlot,
                                releaseSlot,
                                logPrefix,
                                defaultSystemPromptSetting,
                                defaultUserPromptTemplateSetting,
                                useCustomPromptsSetting
                            );
                        }
                        console.log('main.js translateLongDocument 返回:', translationResult);
                        currentTranslationContent = translationResult.translatedText;
                        ocrChunks = translationResult.originalChunks;
                        translatedChunks = translationResult.translatedTextChunks;
                    } else {
                        if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 文档较小 (~${Math.round(estimatedTokens/1000)}K tokens), 直接翻译`);
                        await acquireSlot();
                        if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 翻译槽已获取。调用 API...`);
                        try {
                            if (typeof translateMarkdown !== 'function') throw new Error('translateMarkdown函数未定义');
                            //console.log('main.js 调用 translateMarkdown 参数:', {
                            //    useCustomPromptsSetting,
                            //    defaultUserPromptTemplateSetting,
                            //    defaultSystemPromptSetting,
                            //    translationModelConfig,
                            //    currentMarkdownContent,
                            //    targetLanguageValue,
                            //    selectedTranslationModelName,
                            //    translationKeyValue,
                            //    logPrefix
                            //});
                            //console.log('main.js/document.js 实际传递的 defaultUserPromptTemplateSetting:', defaultUserPromptTemplateSetting);
                            //console.log('main.js/document.js 实际传递的 defaultSystemPromptSetting:', defaultSystemPromptSetting);
                            if (selectedTranslationModelName === 'custom') {
                                currentTranslationContent = await translateMarkdown(
                                    currentMarkdownContent,
                                    targetLanguageValue,
                                    selectedTranslationModelName,
                                    translationKeyValue,
                                    translationModelConfig,
                                    logPrefix,
                                    defaultSystemPromptSetting,
                                    defaultUserPromptTemplateSetting,
                                    useCustomPromptsSetting
                                );
                            } else {
                                currentTranslationContent = await translateMarkdown(
                                    currentMarkdownContent,
                                    targetLanguageValue,
                                    selectedTranslationModelName,
                                    translationKeyValue,
                                    logPrefix,
                                    defaultSystemPromptSetting,
                                    defaultUserPromptTemplateSetting,
                                    useCustomPromptsSetting
                                );
                            }
                            //console.log('main.js translateMarkdown 返回:', currentTranslationContent);
                            ocrChunks = [currentMarkdownContent];
                            translatedChunks = [currentTranslationContent];
                        } finally {
                            releaseSlot();
                            if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} _翻译槽已释放。`);
                        }
                    }
                    if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 翻译完成`);
                } catch (error) {
                    // 判断是否为翻译 Key 失效错误
                    // 这里的判断条件可能需要根据实际API的错误响应来调整
                    if (error.message && (error.message.includes('无效') || error.message.includes('未授权') || error.message.includes('401') || error.message.toLowerCase().includes('invalid api key') || error.message.toLowerCase().includes('unauthorized') || error.message.includes('API key not valid') || error.message.includes('forbidden'))) {
                        if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 翻译 API Key (...${translationKeyValue.slice(-4)}) 可能已失效 (${selectedTranslationModelName}): ${error.message}`);
                        return {
                            file: fileToProcess,
                            keyInvalid: {
                                type: 'translation',
                                modelName: selectedTranslationModelName,
                                keyIdToInvalidate: translationKeyObject.id
                            },
                            error: `翻译 Key 失效: ${error.message}`
                        };
                    }
                    // 其他翻译错误，标记为翻译失败，但OCR结果可能仍有效
                    if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 翻译失败: ${error.message}。将使用原文并标记错误。`);
                    currentTranslationContent = `[翻译失败: ${error.message}] ${currentMarkdownContent}`;
                    ocrChunks = [currentMarkdownContent];
                    translatedChunks = [currentTranslationContent];
                    // 不向上抛出，允许OCR成功但翻译失败的情况，在最终结果中体现
                }
            }
        } else {
            if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 不需要翻译`);
            ocrChunks = [currentMarkdownContent];
            translatedChunks = [''];
        }

        if (typeof saveResultToDB === "function") {
            await saveResultToDB({
                id: `${fileToProcess.name}_${fileToProcess.size}`,
                name: fileToProcess.name,
                size: fileToProcess.size,
                time: new Date().toISOString(),
                ocr: currentMarkdownContent,
                translation: currentTranslationContent,
                images: currentImagesData,
                ocrChunks: ocrChunks,
                translatedChunks: translatedChunks
            });
        }

        if (typeof onFileSuccess === 'function') {
            onFileSuccess(fileToProcess);
        }
        return {
            file: fileToProcess,
            markdown: currentMarkdownContent,
            translation: currentTranslationContent,
            images: currentImagesData,
            ocrChunks: ocrChunks,
            translatedChunks: translatedChunks,
            error: null // 表示此文件处理成功（即使翻译部分可能仅标记了错误）
        };


    } catch (error) { // 捕获OCR流程中的致命错误，或其他未被特定keyInvalid逻辑捕获的错误
        console.error(`${logPrefix} 处理文件时发生严重错误:`, error);
        if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 严重错误: ${error.message}`);
        return {
            file: fileToProcess,
            markdown: null,
            translation: null,
            images: [],
            ocrChunks: [currentMarkdownContent || ''],
            translatedChunks: [`[处理错误: ${error.message}]`],
            error: error.message // 这个error会被 app.js 中的常规重试逻辑捕获
        };
    } finally {
        if (mistralFileId && mistralKeyObject && mistralKeyObject.value && fileType === 'pdf') {
            try {
                await deleteMistralFile(mistralFileId, mistralKeyObject.value);
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 已清理 Mistral 临时文件 (ID: ${mistralFileId})`);
            } catch (deleteError) {
                console.warn(`${logPrefix} 清理 Mistral 文件 ${mistralFileId} 失败:`, deleteError);
                if (typeof addProgressLog === "function") addProgressLog(`${logPrefix} 警告: 清理 Mistral 文件 ${mistralFileId} 失败: ${deleteError.message}`);
            }
        }
    }
}

console.log('main.js: Checking before assignment...');
console.log('main.js: typeof processModule:', typeof processModule);
if (typeof processModule !== 'undefined') {
    console.log('main.js: processModule object keys:', Object.keys(processModule));
}
console.log('main.js: typeof processSinglePdf (the function):', typeof processSinglePdf);
console.log('main.js: Is processSinglePdf a function?', processSinglePdf instanceof Function);


// 将函数添加到processModule对象
if (typeof processModule !== 'undefined') {
    console.log('main.js: Attempting to assign processSinglePdf to processModule...');
    processModule.processSinglePdf = processSinglePdf;
    console.log('main.js: Assignment done. typeof processModule.processSinglePdf:', typeof processModule.processSinglePdf);
    if (processModule.processSinglePdf === null) {
        console.warn('main.js: processModule.processSinglePdf is NULL immediately after assignment!');
    }
} else {
    console.warn('main.js: processModule is undefined at the point of assignment.');
}