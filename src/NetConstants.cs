using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading.Tasks;

namespace LumosProtobuf
{
    /// <summary>
    /// Defines Various Constants for the Ports the Programs
    /// are Listening on
    /// </summary>
    public static class NetConstants
    {
        //12346-12545 are according to IANA Unassigned

        /// <summary>
        /// 225.68.67.3 is the Multicast IP Address. 68 = D, 67 = C => 225.D.C.3 :-D
        /// </summary>
        public static readonly IPAddress DMXCNET_MULTICAST_ADDRESS = IPAddress.Parse("225.68.67.3");


        public static readonly int NETMANAGER_KERNEL_JSON_SEND_PORT = 23242;


        /// <summary>
        /// 17474 is the Port used for Discovery
        /// </summary>
        public static readonly ushort DMXCNET_MULTICAST_PORT = 17474;

        //For 3.3, Port for Broker
        public static readonly ushort UMBRA_LISTEN_PORT = 17475; // 17475 is HEX 0x4443 which is ASCII "DC"
        public static readonly ushort UMBRA_LISTEN_PORT_SECURE = 17476;

        /// <summary>
        /// Maximum Size of a GRPC Message
        /// </summary>
        public static readonly int MAX_MESSAGE_SIZE = 50 * 1024 * 1024; //50 MB

        /// <summary>
        /// Maximum Size of a File to be sent directly as byte[]
        /// </summary>
        public static readonly int MAX_RESOURCE_DIRECT_SEND_SIZE = 5 * 1024 * 1024; //5 MB
    }
}
