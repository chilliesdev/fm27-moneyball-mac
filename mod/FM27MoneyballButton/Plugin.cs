using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using Il2CppInterop.Runtime.Injection;
using UnityEngine;
using UnityEngine.UIElements;

namespace FM27MoneyballButton;

[BepInPlugin("com.fm27.moneyball.button", "FM27 Moneyball Button", "1.0.0")]
public class Plugin : BasePlugin
{
    internal static ManualLogSource Logger;
    private const string DashboardUrl = "http://127.0.0.1:8727/?auto_refresh=1";

    public override void Load()
    {
        Logger = Log;
        ClassInjector.RegisterTypeInIl2Cpp<MoneyballButtonBehaviour>();
        var host = new GameObject("FM27MoneyballButtonHost");
        UnityEngine.Object.DontDestroyOnLoad(host);
        host.hideFlags = HideFlags.HideAndDontSave;
        host.AddComponent<MoneyballButtonBehaviour>();
        Logger.LogInfo("FM27 Moneyball Button plugin loaded.");
    }

    private static (string PythonBin, string ServerScript) ResolveServerPaths()
    {
        var pluginDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? "";
        var cfgPath = Path.Combine(pluginDir, "moneyball.config.txt");
        string pythonBin = "";
        string serverScript = "";

        if (File.Exists(cfgPath))
        {
            foreach (var rawLine in File.ReadAllLines(cfgPath))
            {
                var line = rawLine.Trim();
                if (line.StartsWith("python=", StringComparison.OrdinalIgnoreCase))
                    pythonBin = line.Substring("python=".Length).Trim();
                else if (line.StartsWith("server=", StringComparison.OrdinalIgnoreCase))
                    serverScript = line.Substring("server=".Length).Trim();
            }
        }

        if (string.IsNullOrEmpty(serverScript))
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            serverScript = Path.Combine(home, "Documents", "fm27-moneyball-mac", "scouting", "server.py");
        }

        if (string.IsNullOrEmpty(pythonBin))
        {
            var repoDir = Path.GetDirectoryName(Path.GetDirectoryName(serverScript)) ?? "";
            var venvPy = Path.Combine(repoDir, ".venv", "bin", "python");
            pythonBin = File.Exists(venvPy) ? venvPy : "python3";
        }

        return (pythonBin, serverScript);
    }

    internal static void OpenMoneyballDashboard()
    {
        try
        {
            if (!IsPortOpen("127.0.0.1", 8727))
            {
                var (pythonBin, serverScript) = ResolveServerPaths();
                if (!File.Exists(serverScript))
                {
                    Logger.LogError($"Moneyball server script not found: {serverScript}");
                    return;
                }

                Process.Start(new ProcessStartInfo
                {
                    FileName = pythonBin,
                    Arguments = $"\"{serverScript}\"",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = "/usr/bin/open",
                Arguments = $"\"{DashboardUrl}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            Logger.LogInfo("Opened Moneyball dashboard.");
        }
        catch (Exception ex)
        {
            Logger.LogError($"Failed to open Moneyball dashboard: {ex}");
        }
    }

    private static bool IsPortOpen(string host, int port)
    {
        try
        {
            using var client = new TcpClient();
            var task = client.ConnectAsync(host, port);
            return task.Wait(200) && client.Connected;
        }
        catch
        {
            return false;
        }
    }
}

public class MoneyballButtonBehaviour : MonoBehaviour
{
    private float _nextScanTime;

    public MoneyballButtonBehaviour(IntPtr ptr) : base(ptr) { }

    private void Update()
    {
        if (Time.unscaledTime < _nextScanTime)
            return;
        _nextScanTime = Time.unscaledTime + 2.0f;

        try
        {
            var docs = UnityEngine.Object.FindObjectsOfType<UIDocument>();
            if (docs == null || docs.Length == 0)
                return;

            UIDocument bestDoc = null;
            float bestOrder = float.MinValue;
            foreach (var doc in docs)
            {
                var r = doc?.rootVisualElement;
                if (r == null) continue;
                var existing = r.Q<Button>("moneyball-launch-btn");
                if (existing != null)
                {
                    existing.BringToFront();
                    return;
                }
                if (doc.sortingOrder >= bestOrder)
                {
                    bestOrder = doc.sortingOrder;
                    bestDoc = doc;
                }
            }

            var root = bestDoc?.rootVisualElement;
            if (root == null)
                return;

            var btn = new Button((Action)Plugin.OpenMoneyballDashboard)
            {
                name = "moneyball-launch-btn",
                text = "Moneyball",
            };
            btn.pickingMode = PickingMode.Position;
            btn.style.position = Position.Absolute;
            btn.style.right = 18f;
            btn.style.bottom = 18f;
            btn.style.paddingLeft = 12f;
            btn.style.paddingRight = 12f;
            btn.style.paddingTop = 6f;
            btn.style.paddingBottom = 6f;
            btn.style.backgroundColor = new StyleColor(new Color(0.96f, 0.62f, 0.04f, 0.95f));
            btn.style.color = new StyleColor(new Color(0.08f, 0.06f, 0.03f, 1f));
            btn.style.borderTopLeftRadius = 6f;
            btn.style.borderTopRightRadius = 6f;
            btn.style.borderBottomLeftRadius = 6f;
            btn.style.borderBottomRightRadius = 6f;
            btn.style.unityFontStyleAndWeight = FontStyle.Bold;
            btn.style.fontSize = 12f;

            root.Add(btn);
            btn.BringToFront();
            Plugin.Logger.LogInfo($"Injected Moneyball button into UIDocument '{bestDoc.name}' (sortingOrder={bestDoc.sortingOrder}, totalDocs={docs.Length}).");
        }
        catch (Exception ex)
        {
            Plugin.Logger.LogWarning($"UIDocument scan skipped: {ex.Message}");
        }
    }
}
