import QtQuick
import Quickshell
import Quickshell.Wayland

ShellRoot {
    PanelWindow {
        id: panel
        property bool pressedOnce: false
        implicitWidth: 32
        implicitHeight: 24
        color: "transparent"
        anchors.top: true
        anchors.left: true
        screen: Quickshell.screens[0]
        exclusiveZone: 0
        WlrLayershell.layer: WlrLayer.Top
        WlrLayershell.namespace: "ricebox-layer-proof"

        // Both colors cover the whole surface: this fixture requires full damage.
        Rectangle {
            anchors.fill: parent
            color: panel.pressedOnce ? "#8040ff80" : "#80ff8040"
            MouseArea {
                anchors.fill: parent
                onClicked: {
                    if (!panel.pressedOnce) {
                        panel.pressedOnce = true;
                        retire.start();
                    }
                }
            }
        }
    }
    // The listener closes the layer; then exit the test process as in shell.qml.
    // This timer cannot cause either of the two tested frames.
    Timer {
        id: retire
        interval: 4000
        onTriggered: Qt.quit()
    }
}
