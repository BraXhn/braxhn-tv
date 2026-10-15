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
                #if os(iOS)
                // Återanslut till nedladdningarnas bakgrundssession direkt vid start
                .onAppear { _ = Downloads.shared }
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
