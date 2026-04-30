//
//  Transcription.swift
//  VoiceLog
//
//  Created by Xin Du on 2023/07/15.
//

import Foundation
import CoreData
import XLog
import Combine

enum TranscriptionError: LocalizedError {
    case invalidCustomServer
    var errorDescription: String? {
        switch self {
        case .invalidCustomServer: return L(.error_invalid_custom_server)
        }
    }
}

class Transcription {
    
    static let shared = Transcription()
    
    private let TAG = "Trans"
    
    var memoQueue = [(MemoEntity, (Result<String, Error>) -> Void)]()
    var activeTask = 0
    private var inflightIDs = Set<NSManagedObjectID>()
    
    /// 转写最大并发
    var maxConcurrent: Int {
        if Config.shared.transProvider == .apple {
            return 1
        }
        return Config.shared.serverType == .app ? 2 : 4
    }
    
    /// 延迟
    var delay: UInt64 {
        if Config.shared.transProvider == .apple {
            return 1
        }
        return Config.shared.serverType == .app ? 1 : 0
    }
    
    let hallucinationList: Set<String> = [
        "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
        "請不吝點贊訂閱轉發打賞支持明鏡與點點欄目",
        "字幕由Amara.org社区提供",
        "字幕由Amara.org社区提供 字幕由Amara.org社区提供",
        "小編字幕由Amara.org社區提供",
        "字幕by索兰娅",
        "由 Amara.org 社群提供的字幕"
    ]
    
    func transcribe(voiceURL: URL, provider: TranscriptionProvider, lang: TranscriptionLang) async throws -> String {
        XLog.info("Transcribe \(voiceURL.lastPathComponent) using \(provider). lang = \(lang.rawValue)", source: TAG)
        if provider == .apple {
            let text = try await SpeechRecognizer.shared.transcribe(voiceURL, lang: lang)
            return text
        } else if provider == .openai {
            if Config.shared.serverType == .custom && !Config.shared.isServerSet {
                throw TranscriptionError.invalidCustomServer
            }
            
            let model = Config.shared.transModel
            let text = try await OpenAIClient.shared.transcribe(voiceURL, lang: lang, model: model.name).text
            if hallucinationList.contains(text) {
                XLog.info("😵‍💫 skip '\(text)'", source: TAG)
                return ""
            }
            return text
        }
        return ""
    }
    
    func transcribe(_ memo: MemoEntity, completion: @escaping (Result<String, Error>) -> Void) {
        let id = memo.objectID
        if inflightIDs.contains(id) {
            XLog.info("Transcription already in flight for \(id), skipped", source: TAG)
            return
        }
        inflightIDs.insert(id)
        memoQueue.append((memo, { [weak self] result in
            self?.inflightIDs.remove(id)
            completion(result)
        }))
        processNext()
    }
    
    private func processNext() {
        while !memoQueue.isEmpty && activeTask < maxConcurrent {
            activeTask += 1
            let (memo, completion) = memoQueue.removeFirst()
            
            Task { @MainActor in
                do {
                    try await Task.sleep(nanoseconds: delay * 1_000_000_000)
                    let voiceURL = FileHelper.fullAudioURL(for: memo.file!)
                    let text = try await transcribe(voiceURL: voiceURL, provider: Config.shared.transProvider, lang: Config.shared.transLang)
                    completion(.success(text))
                } catch {
                    completion(.failure(error))
                }
                activeTask -= 1
                processNext()
            }
        }
    }
}
