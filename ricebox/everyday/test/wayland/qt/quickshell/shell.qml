import QtQuick
import Quickshell
import Quickshell.Wayland

ShellRoot {
    PanelWindow {
        id: panel
        implicitWidth: 32
        implicitHeight: 24
        color: "transparent"
        anchors.top: true
        anchors.left: true
        screen: Quickshell.screens[0]
        exclusiveZone: 0
        WlrLayershell.layer: WlrLayer.Top
        WlrLayershell.namespace: "ricebox-layer-proof"

        Rectangle {
            x: 10
            y: 8
            width: 8
            height: 6
            color: "#80ff8040"
        }
    }
    Timer {
        running: true
        interval: 4000
        onTriggered: Qt.quit()
    }
}
