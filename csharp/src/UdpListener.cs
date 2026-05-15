using System;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace LumosProtobuf.Udp
{
    public class UdpListener : IDisposable
    {
        private readonly int listenerPort;
        private readonly UdpClient listener;
        private readonly IPAddress multicastIP;

        public event EventHandler<UdpEventArgs> UdpDataReceived;

        private readonly CancellationTokenSource _cts = new CancellationTokenSource();

        private bool listening = false;

        public UdpListener(ushort listenPort, IPAddress multicastIP = null)
        {
            listenerPort = listenPort;
            this.multicastIP = multicastIP;
            listener = new UdpClient();
            listener.ExclusiveAddressUse = false;
            listener.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        }

        public void StartListen()
        {
            if (listening)
                throw new InvalidOperationException("Already Listening");

            listener.EnableBroadcast = true;
            listener.Client.Bind(new IPEndPoint(IPAddress.Any, listenerPort));

            Task.Run(listenerTaskRun);
            listening = true;
        }

        public void AddMulticastListenIPAddress(IPAddress ipAddress)
        {
            if (multicastIP == null)
                throw new InvalidOperationException("MulticastIP not defined in constructor");
            if (ipAddress == null)
                throw new ArgumentNullException(nameof(ipAddress));

            listener.JoinMulticastGroup(multicastIP, ipAddress);
        }

        public bool IsDisposed
        {
            get;
            private set;
        }

        #region IDisposable Member

        public void Dispose()
        {
            if (IsDisposed)
                return;

            UdpDataReceived = null;

            IsDisposed = true;
            _cts.Cancel();
        }

        #endregion

        private async Task listenerTaskRun()
        {
            uint receiveCounter = 0;
            var token = _cts.Token;
            var registration = token.Register(() =>
            {
                listener.Close();
            });

            using (registration)
            {
                try
                {
                    while (!IsDisposed)
                    {
                        try
                        {
                            token.ThrowIfCancellationRequested();

                            var p = await listener.ReceiveAsync();
                            receiveCounter++;
                            _ = Task.Run(() => UdpDataReceived?.Invoke(this, new UdpEventArgs(p.Buffer, p.RemoteEndPoint)));
                        }
                        catch (ObjectDisposedException)
                        {
                            //Ignore
                        }
                        catch (OperationCanceledException)
                        {
                            //Ignore
                        }
                    }
                }
                finally
                {
                    try
                    {
                        listener.Close();
                    }
                    catch
                    {
                        /* Ignore */
                    }

                    try
                    {
                        (listener as IDisposable)?.Dispose();
                    }
                    catch
                    {
                        /* Ignore */
                    }
                }
            }
        }
    }

    public class UdpEventArgs : EventArgs
    {
        public readonly byte[] Data;
        public readonly IPEndPoint EndPoint;

        public UdpEventArgs(byte[] data, IPEndPoint ep)
        {
            Data = data;
            EndPoint = ep;
        }
    }
}
