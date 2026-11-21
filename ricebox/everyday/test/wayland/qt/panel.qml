import QtQuick
import org.kde.layershell as Layers

Window {
    width: 32
    height: 24
    visible: true
    color: "#121c2a"
    Layers.Window.scope: "ricebox-layer-proof"
    Layers.Window.layer: Layers.Window.LayerTop
    Layers.Window.anchors: Layers.Window.AnchorTop | Layers.Window.AnchorLeft
    Layers.Window.exclusionZone: 0
    Layers.Window.keyboardInteractivity: Layers.Window.KeyboardInteractivityNone

    Rectangle {
        x: 10
        y: 8
        width: 8
        height: 6
        color: "#f83d69"
    }
}
