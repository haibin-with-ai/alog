//
//  DataContainer+Notification.swift
//  VoiceLog
//
//  Created by Xin Du on 2023/08/05.
//

import Foundation
import UIKit
import WatchConnectivity
import XLog

extension DataContainer {
    func registerNotifications() {
        NotificationCenter.default.addObserver(self, selector: #selector(didReceiveFileFromWatch), name: .receivedFileFromWatch, object: nil)
    }
    
    @objc func didReceiveFileFromWatch(_ notification: Notification) {
        guard let file = notification.object as? WCSessionFile else { return }
        let voiceURL = file.fileURL
        
        do {
            _ = try FileHelper.moveAudioFile(voiceURL)
        } catch {
            XLog.error(error, source: "DC")
            return
        }
        
        DispatchQueue.main.async {
            let memo = MemoEntity.newEntity(moc: self.context)
            memo.file = voiceURL.lastPathComponent
            memo.content = ""
            memo.transcribed = false
            memo.isFromWatch = true
            
            if let metadata = file.metadata {
                XLog.info(metadata, source: "DC")
                memo.timezone = (metadata["timezone"] as? String) ?? TimeZone.current.identifier
                memo.createdAt = (metadata["createdAt"] as? Date) ?? Date()
                memo.duration = (metadata["duration"] as? Double) ?? 0
            }
            
            do {
                try self.context.save()
                self.transcribeWatchMemoInBackground(memo)
            } catch {
                XLog.error(error, source: "DC")
            }
        }
    }

    /// 收到 Watch 录音后立刻触发一次转录，独立于 TimelineViewModel
    /// （后者依赖 UI 在屏幕上）。在后台用 beginBackgroundTask 续命，前台不申请额外时间。
    /// Transcription.shared 自带按 objectID 去重，前台 TimelineViewModel 已抢先触发时这里会被跳过。
    private func transcribeWatchMemoInBackground(_ memo: MemoEntity) {
        guard memo.needsTranscription else { return }
        guard Config.shared.transEnabled else { return }

        let inBackground = UIApplication.shared.applicationState != .active

        var taskID: UIBackgroundTaskIdentifier = .invalid
        if inBackground {
            taskID = UIApplication.shared.beginBackgroundTask(withName: "AutoTranscribeWatchMemo") {
                if taskID != .invalid {
                    UIApplication.shared.endBackgroundTask(taskID)
                    taskID = .invalid
                }
            }
        }

        Transcription.shared.transcribe(memo) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let text):
                    if memo.content != text {
                        memo.content = text
                        memo.transcribed = true
                        try? self?.context.save()
                    }
                case .failure(let error):
                    XLog.error(error, source: "DC.AutoTranscribe")
                }
                if taskID != .invalid {
                    UIApplication.shared.endBackgroundTask(taskID)
                    taskID = .invalid
                }
            }
        }
    }
}

