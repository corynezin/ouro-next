// The Face ID cover in a window of its own. A view inside React Native's window sits below any sheet UIKit presents, and
// a React Native Modal can't present over one, so the cover gets a window above everything the app shows.
import ExpoModulesCore
import UIKit

public class LockWindowModule: Module {
  private var coverWindow: UIWindow?
  /** Given the keyboard back when the cover goes. */
  private weak var keyWindowBeforeCover: UIWindow?

  public func definition() -> ModuleDefinition {
    Name("LockWindow")
    Events("onUnlockPress")

    // Sync functions run on the JS thread and can't take runOnQueue (only AsyncFunction can), so each hops to main.
    // The main queue is FIFO, so a show and a hide keep their order.
    /** Shows the cover, or updates the one showing. The Unlock button shows only when `unlockable`. */
    Function("show") { (unlockable: Bool) in
      DispatchQueue.main.async { self.show(unlockable: unlockable) }
    }

    Function("hide") {
      DispatchQueue.main.async { self.hide() }
    }

    OnDestroy {
      DispatchQueue.main.async { self.hide() }
    }
  }

  private func show(unlockable: Bool) {
    if let window = coverWindow, let cover = window.rootViewController as? LockCoverViewController {
      cover.setUnlockable(unlockable)
      return
    }
    guard let scene = Self.windowScene() else { return }
    let cover = LockCoverViewController(onUnlockPress: { [weak self] in self?.sendEvent("onUnlockPress") })
    cover.setUnlockable(unlockable)
    let window = UIWindow(windowScene: scene)
    window.windowLevel = .alert + 1
    window.rootViewController = cover
    keyWindowBeforeCover = scene.windows.first { $0.isKeyWindow }
    // Key, so a text field below loses the keyboard and nothing below takes input.
    window.makeKeyAndVisible()
    coverWindow = window
  }

  private func hide() {
    guard let window = coverWindow else { return }
    window.isHidden = true
    coverWindow = nil
    keyWindowBeforeCover?.makeKey()
    keyWindowBeforeCover = nil
  }

  /** While switching away the scene is inactive rather than active, and the cover must still go on it. */
  private static func windowScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive }
      ?? scenes.first { $0.activationState == .foregroundInactive }
      ?? scenes.first
  }
}

/** Drawn like the cover React Native draws on builds without this module: lock, title, and the Unlock button. */
final class LockCoverViewController: UIViewController {
  private let onUnlockPress: () -> Void
  private let unlockButton = UIButton(type: .system)

  init(onUnlockPress: @escaping () -> Void) {
    self.onUnlockPress = onUnlockPress
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    view.accessibilityViewIsModal = true

    let lock = UIImageView(image: UIImage(systemName: "lock.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 40)))
    lock.tintColor = .secondaryLabel

    let title = UILabel()
    title.text = "Ouro is locked"
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    title.textColor = .label

    var button = UIButton.Configuration.filled()
    button.title = "Unlock with Face ID"
    button.baseBackgroundColor = .systemBlue
    button.baseForegroundColor = .white
    button.cornerStyle = .fixed
    button.background.cornerRadius = 12
    button.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20)
    button.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var attributes = attributes
      attributes.font = .systemFont(ofSize: 16, weight: .semibold)
      return attributes
    }
    unlockButton.configuration = button
    unlockButton.addAction(UIAction { [weak self] _ in self?.onUnlockPress() }, for: .touchUpInside)

    let stack = UIStackView(arrangedSubviews: [lock, title, unlockButton])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }

  func setUnlockable(_ unlockable: Bool) {
    loadViewIfNeeded()
    unlockButton.isHidden = !unlockable
  }
}
