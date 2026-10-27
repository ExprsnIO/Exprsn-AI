import Foundation

/// Reads `text/event-stream` bodies (the OpenAI-compatible `/v1/chat/completions` with `stream: true`).
enum SSE {
    /// Yields the `data:` payload of each event; stops at `[DONE]`.
    static func events(_ bytes: URLSession.AsyncBytes) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    var data = ""
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            if !data.isEmpty { if data == "[DONE]" { break }; continuation.yield(data); data = "" }
                        } else if line.hasPrefix("data:") {
                            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                            data += (data.isEmpty ? "" : "\n") + payload
                        }
                    }
                    if !data.isEmpty && data != "[DONE]" { continuation.yield(data) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
        }
    }
}
