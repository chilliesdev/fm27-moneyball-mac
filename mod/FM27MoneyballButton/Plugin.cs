using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using BepInEx;
using BepInEx.Logging;
using BepInEx.Unity.IL2CPP;
using Il2CppInterop.Runtime.Injection;
using Il2CppInterop.Runtime.InteropTypes.Arrays;
using UnityEngine;
using UnityEngine.UIElements;

namespace FM27MoneyballButton;

[BepInPlugin("com.fm27.moneyball.button", "FM27 Moneyball Button", "1.0.0")]
public class Plugin : BasePlugin
{
    internal static ManualLogSource Logger;
    private const string DashboardUrl = "http://127.0.0.1:8727/?auto_refresh=1";
    private const int ServerPort = 8727;
    private static int _launching;
    internal static bool IsLaunching => Volatile.Read(ref _launching) != 0;

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

    private static (string PythonBin, string ServerScript, string Anchor, float OffsetX, float OffsetY) ResolveServerConfig()
    {
        var pluginDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location) ?? "";
        var cfgPath = Path.Combine(pluginDir, "moneyball.config.txt");
        string pythonBin = "";
        string serverScript = "";
        string anchor = "bottom-right";
        float offsetX = 18f;
        float offsetY = 18f;

        if (File.Exists(cfgPath))
        {
            foreach (var rawLine in File.ReadAllLines(cfgPath))
            {
                var line = rawLine.Trim();
                if (line.StartsWith("python=", StringComparison.OrdinalIgnoreCase))
                    pythonBin = line.Substring("python=".Length).Trim();
                else if (line.StartsWith("server=", StringComparison.OrdinalIgnoreCase))
                    serverScript = line.Substring("server=".Length).Trim();
                else if (line.StartsWith("anchor=", StringComparison.OrdinalIgnoreCase))
                    anchor = line.Substring("anchor=".Length).Trim().ToLowerInvariant();
                else if (line.StartsWith("offset_x=", StringComparison.OrdinalIgnoreCase) &&
                         float.TryParse(line.Substring("offset_x=".Length).Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var ox))
                    offsetX = ox;
                else if (line.StartsWith("offset_y=", StringComparison.OrdinalIgnoreCase) &&
                         float.TryParse(line.Substring("offset_y=".Length).Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var oy))
                    offsetY = oy;
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

        return (pythonBin, serverScript, anchor, offsetX, offsetY);
    }

    internal static (string Anchor, float OffsetX, float OffsetY) GetButtonPlacement()
    {
        var (_, _, anchor, ox, oy) = ResolveServerConfig();
        return (anchor, ox, oy);
    }

    private static void LaunchBrowser()
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "/usr/bin/open",
            Arguments = $"\"{DashboardUrl}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        Logger.LogInfo("Opened Moneyball dashboard.");
    }

    internal static void OpenMoneyballDashboard()
    {
        if (Interlocked.CompareExchange(ref _launching, 1, 0) != 0)
            return;

        try
        {
            if (IsPortOpen("127.0.0.1", ServerPort))
            {
                LaunchBrowser();
                Interlocked.Exchange(ref _launching, 0);
                return;
            }

            var (pythonBin, serverScript, _, _, _) = ResolveServerConfig();
            if (!File.Exists(serverScript))
            {
                Logger.LogError($"Moneyball server script not found: {serverScript}");
                Interlocked.Exchange(ref _launching, 0);
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = pythonBin,
                Arguments = $"\"{serverScript}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            });

            Task.Run(() =>
            {
                try
                {
                    if (!WaitForPort("127.0.0.1", ServerPort, timeoutMs: 3000))
                        Logger.LogWarning($"Moneyball server did not listen on port {ServerPort} within 3s; opening browser anyway.");
                    LaunchBrowser();
                }
                catch (Exception ex)
                {
                    Logger.LogError($"Failed to open Moneyball dashboard: {ex}");
                }
                finally
                {
                    Interlocked.Exchange(ref _launching, 0);
                }
            });
        }
        catch (Exception ex)
        {
            Interlocked.Exchange(ref _launching, 0);
            Logger.LogError($"Failed to open Moneyball dashboard: {ex}");
        }
    }

    private static bool WaitForPort(string host, int port, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            if (IsPortOpen(host, port))
                return true;
            Thread.Sleep(50);
        }
        return IsPortOpen(host, port);
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
    private const string IconResourceName = "FM27MoneyballButton.moneyball-icon.png";
    private static Texture2D _cachedIconTexture;
    private static bool _iconLoadAttempted;
    private float _nextScanTime;
    private Button _button;

    public MoneyballButtonBehaviour(IntPtr ptr) : base(ptr) { }

    private static Texture2D GetOrLoadIconTexture()
    {
        if (_cachedIconTexture != null)
            return _cachedIconTexture;
        if (_iconLoadAttempted)
            return null;
        _iconLoadAttempted = true;

        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using var stream = asm.GetManifestResourceStream(IconResourceName);
            if (stream == null)
            {
                Plugin.Logger.LogWarning($"Embedded icon resource not found: {IconResourceName}");
                return null;
            }

            using var ms = new MemoryStream();
            stream.CopyTo(ms);
            var bytes = ms.ToArray();

            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false)
            {
                hideFlags = HideFlags.HideAndDontSave,
                filterMode = FilterMode.Bilinear,
            };

            if (!ImageConversion.LoadImage(tex, new Il2CppStructArray<byte>(bytes), false))
            {
                Plugin.Logger.LogWarning($"ImageConversion.LoadImage failed for {IconResourceName}.");
                UnityEngine.Object.Destroy(tex);
                return null;
            }

            _cachedIconTexture = tex;
            return _cachedIconTexture;
        }
        catch (Exception ex)
        {
            Plugin.Logger.LogWarning($"Failed to load Moneyball icon texture: {ex.Message}");
            return null;
        }
    }

    private void Update()
    {
        if (_button != null && _button.panel != null)
        {
            _button.style.opacity = Plugin.IsLaunching ? 0.65f : 1.0f;
            _button.tooltip = Plugin.IsLaunching ? "Opening Moneyball Scout..." : "Moneyball Scout";
        }

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
                    _button = existing;
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
                tooltip = "Moneyball Scout",
            };
            var (anchor, offsetX, offsetY) = Plugin.GetButtonPlacement();
            btn.pickingMode = PickingMode.Position;
            btn.style.position = Position.Absolute;
            if (anchor.Contains("left"))
                btn.style.left = offsetX;
            else
                btn.style.right = offsetX;
            if (anchor.Contains("top"))
                btn.style.top = offsetY;
            else
                btn.style.bottom = offsetY;
            btn.style.width = 40f;
            btn.style.height = 40f;
            btn.style.paddingLeft = 3f;
            btn.style.paddingRight = 3f;
            btn.style.paddingTop = 3f;
            btn.style.paddingBottom = 3f;
            btn.style.marginLeft = 0f;
            btn.style.marginRight = 0f;
            btn.style.marginTop = 0f;
            btn.style.marginBottom = 0f;
            btn.style.borderLeftWidth = 0f;
            btn.style.borderRightWidth = 0f;
            btn.style.borderTopWidth = 0f;
            btn.style.borderBottomWidth = 0f;
            btn.style.justifyContent = Justify.Center;
            btn.style.alignItems = Align.Center;
            btn.style.backgroundColor = new StyleColor(new Color(0.06f, 0.08f, 0.12f, 0.94f));
            btn.style.borderTopLeftRadius = 20f;
            btn.style.borderTopRightRadius = 20f;
            btn.style.borderBottomLeftRadius = 20f;
            btn.style.borderBottomRightRadius = 20f;

            var iconTex = GetOrLoadIconTexture();
            if (iconTex != null)
            {
                var iconImg = new UnityEngine.UIElements.Image
                {
                    image = iconTex,
                    scaleMode = ScaleMode.ScaleToFit,
                    pickingMode = PickingMode.Ignore,
                };
                iconImg.style.width = 32f;
                iconImg.style.height = 32f;
                btn.Add(iconImg);
            }

            root.Add(btn);
            _button = btn;
            btn.BringToFront();
            Plugin.Logger.LogInfo($"Injected Moneyball button into UIDocument '{bestDoc.name}' (sortingOrder={bestDoc.sortingOrder}, totalDocs={docs.Length}).");
        }
        catch (Exception ex)
        {
            Plugin.Logger.LogWarning($"UIDocument scan skipped: {ex.Message}");
        }
    }
}
