/* Independent guest application: Linux socket/DNS behavior, not a VM backend. */
#define _POSIX_C_SOURCE 200112L
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <netdb.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdint.h>

int main(void)
{
    const uint8_t query[]={0x12,0x34,1,0,0,1,0,0,0,0,0,0,
        7,'e','x','a','m','p','l','e',3,'c','o','m',0,0,1,0,1};
    int fd=socket(AF_INET,SOCK_DGRAM,0);
    struct timeval limit={3,0};
    struct sockaddr_in server={0};
    server.sin_family=AF_INET;server.sin_port=htons(53);
    server.sin_addr.s_addr=htonl(0x0a000203u);
    if(fd<0||setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&limit,sizeof limit))return 2;
    ssize_t sent=sendto(fd,query,sizeof query,0,(struct sockaddr *)&server,sizeof server);
    uint8_t response[2048];
    ssize_t received=recv(fd,response,sizeof response,0);int saved=errno;
    printf("oracle-dns-datagram: sent=%ld received=%ld errno=%d\n",(long)sent,(long)received,saved);
    if(received>0){for(ssize_t n=0;n<received&&n<64;++n)printf("%02x",response[n]);puts("");}
    close(fd);
    if(sent!=(ssize_t)sizeof query||received<12||response[0]!=0x12||response[1]!=0x34||!(response[2]&128u))return 3;
    struct addrinfo *addresses=NULL;
    int result=getaddrinfo("example.com","443",NULL,&addresses);
    printf("oracle-resolver:%d\n",result);
    if(!result)freeaddrinfo(addresses);
    return result!=0;
}
