import SwiftUI

@main
struct BraXhnTVApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                #if os(iOS)
                // Återanslut till nedladdningarnas bakgrundssession direkt vid start
                .onAppear { _ = Downloads.shared }
                #endif
        }
    }
}
