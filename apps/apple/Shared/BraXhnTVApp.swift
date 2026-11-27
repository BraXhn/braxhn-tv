import SwiftUI

@main
struct BraXhnTVApp: App {
    @StateObject private var model = AppModel()
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif
    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                // Nedladdningarna (iPhone/iPad) och köade positioner gäller profilen som är inloggad (Offline.swift);
                // på iPhone/iPad återansluter det också till nedladdningarnas bakgrundssession direkt vid start
                .onAppear { OfflineProfile.changed(model) }
                // Köade positioner skickas och den automatiska offline-synken körs när appen kommer till förgrunden
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
                    PendingPositions.shared.flush()
                    #if os(iOS)
                    Task { await Downloads.shared.autoSync(model: model) }
                    #endif
                }
                #if os(iOS)
                .task { await Downloads.shared.autoSync(model: model) }
                #endif
        }
    }
}

#if os(iOS)
/// Systemet startar appen i bakgrunden när en nedladdning blivit klar. Återanslut till sessionen så att
/// filen flyttas på plats direkt (inte först när appen öppnas), och meddela systemet när allt är hanterat.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        BackgroundDownloadEvents.shared.set(completionHandler)
        Task { @MainActor in _ = Downloads.shared }
    }
}
#endif
