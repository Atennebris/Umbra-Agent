using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Umbra.Core
{
    public delegate void TaskHandler(string taskId);

    public class DaemonService
    {
        private readonly List<string> _tasks = new();
        private readonly string _version = "1.0.0";

        public string Host { get; set; } = "127.0.0.1";
        public int Port { get; init; } = 5100;
        public bool IsRunning { get; private set; }

        public event EventHandler DaemonStarted;
        public event EventHandler<string> TaskCompleted;

        public DaemonService(string host, int port)
        {
            Host = host;
            Port = port;
        }

        ~DaemonService()
        {
            Dispose();
        }

        public void Start()
        {
            IsRunning = true;
            DaemonStarted?.Invoke(this, EventArgs.Empty);
        }

        public void Stop()
        {
            IsRunning = false;
        }

        public async Task<bool> ExecuteAsync(string task)
        {
            _tasks.Add(task);
            await Task.Delay(10);
            TaskCompleted?.Invoke(this, task);
            return true;
        }

        public static DaemonService operator +(DaemonService a, DaemonService b)
        {
            return new DaemonService(a.Host, a.Port);
        }
    }

    public interface IService
    {
        void Start();
        void Stop();
        bool IsRunning { get; }
    }

    public struct Config
    {
        public string Host;
        public int Port;
        public bool TlsEnabled;
    }

    public enum DaemonState
    {
        Running,
        Stopped,
        Error,
        Initializing
    }

    public record SessionInfo(string Id, string Model, DateTime CreatedAt);

    public record struct TokenUsage(int Prompt, int Completion)
    {
        public int Total => Prompt + Completion;
    }
}
