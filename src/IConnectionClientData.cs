using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Grpc.Core;

namespace LumosProtobuf.ConnectionClient
{
    public interface IConnectionClientData
    {

        ChannelBase UmbraChannel { get; }

        ChannelBase CreateChannel(string host, int port);

        Metadata HostMetadata { get; }

        ClientProgramInfo ClientProgramInfo { get; }

        string Clientname { get; }
        string NetworkID { get; }
    }
}
