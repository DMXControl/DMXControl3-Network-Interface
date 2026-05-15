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
