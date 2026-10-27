import Foundation

/// What a screen knows about the data it asked for.
enum Loadable<T> {
    case idle
    case loading
    case loaded(T)
    case failed(APIProblem)

    var value: T? { if case .loaded(let v) = self { return v }; return nil }
    var isLoading: Bool { if case .loading = self { return true }; return false }
    var problem: APIProblem? { if case .failed(let p) = self { return p }; return nil }
}

extension Error {
    var asProblem: APIProblem { (self as? APIProblem) ?? APIProblem.transport(self) }
}

/// Runs an async load and maps the outcome onto a `Loadable`.
func loaded<T>(_ work: () async throws -> T) async -> Loadable<T> {
    do { return .loaded(try await work()) } catch { return .failed(error.asProblem) }
}
