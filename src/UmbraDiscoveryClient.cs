using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Text;
using System.Threading.Tasks;
using Google.Protobuf;
using log4net;

namespace LumosProtobuf.Udp
{
    public class UmbraDiscoveryClient : IDisposable
    {
        private UdpListener _umbraBroadcastListener;

        public event EventHandler<UmbraDiscoveryBroadcastEventArgs> UmbraDiscoveryBroadcastReceived;

        private readonly Queue<UmbraUdpBroadcast> _receivedBroadcasts = new Queue<UmbraUdpBroadcast>(); 

        public int BroadcastHistoryMax { get; set; } = 100;

        public IReadOnlyList<UmbraUdpBroadcast> GetBroadcastHistory(bool fromNewToOld, int limit)
        {
            lock (_receivedBroadcasts)
            {
                IEnumerable<UmbraUdpBroadcast> list = _receivedBroadcasts;
                if (fromNewToOld)
                    list = list.Reverse();
                if (limit > 0 && limit < _receivedBroadcasts.Count)
                    list = list.Take(limit);

                return list.ToList().AsReadOnly(); //Copy
            }
        }

        public ILog Logger { get; set; }

        public void StartDiscovery()
        {
            var av = NetworkInterface.GetIsNetworkAvailable();
            if (!av)
                StartDiscovery(null);
            else
            {
                var ips = NetworkInterface.GetAllNetworkInterfaces()
                    .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
                    .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                    .Select(n => n.Address)
                    .Where(n => n.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    .ToList();
                StartDiscovery(ips);
            }
        }

        public void StartDiscovery(IReadOnlyCollection<IPAddress> listenAdresses)
        {
            if (_umbraBroadcastListener != null)
            {
                _umbraBroadcastListener.UdpDataReceived -= _umbraBroadcastListener_UdpDataReceived;
                _umbraBroadcastListener.Dispose();
            }

            _umbraBroadcastListener = new UdpListener(NetConstants.DMXCNET_MULTICAST_PORT, NetConstants.DMXCNET_MULTICAST_ADDRESS);
            _umbraBroadcastListener.StartListen();

            if (listenAdresses == null || listenAdresses.Count == 0)
            {
                Logger?.Warn("Network not available. Only listening Broadcast");
            }
            else
            {

                foreach (var a in listenAdresses)
                {
                    try
                    {
                        Logger?.InfoFormat("Listening on {0} for Umbra Multicasts", a);
                        _umbraBroadcastListener.AddMulticastListenIPAddress(a);
                    }
                    catch (Exception)
                    {
                        Logger?.WarnFormat("Unable to Listen on IP Address: {0}", a);
                    }
                }

            }
            _umbraBroadcastListener.UdpDataReceived += _umbraBroadcastListener_UdpDataReceived;
        }


        public void Dispose()
        {
            if (_umbraBroadcastListener != null)
            {
                _umbraBroadcastListener.UdpDataReceived -= _umbraBroadcastListener_UdpDataReceived;
                _umbraBroadcastListener.Dispose();
                _umbraBroadcastListener = null;
            }

            UmbraDiscoveryBroadcastReceived = null;
        }

        private void _umbraBroadcastListener_UdpDataReceived(object sender, UdpEventArgs args)
        {
            try
            {
                UmbraUdpBroadcast d = new UmbraUdpBroadcast();
                using (var cis = new CodedInputStream(args.Data))
                    d.MergeFrom(cis);

                d.SourceEndPoint = args.EndPoint.Address.ToString();
                lock (_receivedBroadcasts)
                {
                    _receivedBroadcasts.Enqueue(d);
                    while (_receivedBroadcasts.Count > BroadcastHistoryMax)
                        _receivedBroadcasts.Dequeue();
                }

                UmbraDiscoveryBroadcastReceived?.Invoke(this, new UmbraDiscoveryBroadcastEventArgs(d, args.EndPoint));
            }
            catch (Exception e)
            {
                Logger?.Debug($"Unable to deserialize Data: {e.Message}", e);
            }
        }

    }

    public class UmbraDiscoveryBroadcastEventArgs : EventArgs
    {
        public readonly UmbraUdpBroadcast Broadcast;
        public readonly IPEndPoint EndPoint;

        public UmbraDiscoveryBroadcastEventArgs(UmbraUdpBroadcast bc, IPEndPoint ep)
        {
            this.Broadcast = bc;
            this.EndPoint = ep;
        }
    }
}
