using System;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Threading;
using System.Net;
using System.Runtime.Serialization.Formatters.Binary;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Google.Protobuf;

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
            this.listenerPort = listenPort;
            this.multicastIP = multicastIP;
            this.listener = new UdpClient();
            this.listener.ExclusiveAddressUse = false;
            this.listener.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        }

        public void StartListen()
        {
            if (listening)
                throw new InvalidOperationException("Already Listening");

            this.listener.EnableBroadcast = true;
            this.listener.Client.Bind(new IPEndPoint(IPAddress.Any, this.listenerPort));
            
            Task.Run(listenerTaskRun);
            listening = true;
        }

        public void AddMulticastListenIPAddress(IPAddress ipAddress)
        {
            if (this.multicastIP == null) throw new InvalidOperationException("MulticastIP not defined in constructor");
            if (ipAddress == null) throw new ArgumentNullException(nameof(ipAddress));

            this.listener.JoinMulticastGroup(multicastIP, ipAddress);
        }

        public bool IsDisposed
        {
            get;
            private set;
        }

        #region IDisposable Member

        public void Dispose()
        {
            if (IsDisposed) return;

            UdpDataReceived = null;

            this.IsDisposed = true;
            _cts.Cancel();
        }

        #endregion

        private async Task listenerTaskRun()
        {
            uint receiveCounter = 0;
            var token = _cts.Token;
            var registration = token.Register(() =>
            {
                this.listener.Close();
            });

            using (registration)
            {
                try
                {
                    while (!this.IsDisposed)
                    {
                        try
                        {
                            token.ThrowIfCancellationRequested();

                            var p = await this.listener.ReceiveAsync();
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
                    try { this.listener.Close(); }
                    catch { /* Ignore */ }

                    try { (this.listener as IDisposable)?.Dispose(); }
                    catch { /* Ignore */ }
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
            this.Data = data;
            this.EndPoint = ep;
        }
    }
}
