/* A denied read is successful evidence only for EACCES after real UID/GID
 * reduction. Crashes, authentication failure and root mode displays do not pass. */
#define _GNU_SOURCE
#include <unistd.h>
#include <grp.h>
#include <pwd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
int main(int argc,char **argv)
{
    if(argc!=3)return 2;
    const struct passwd *user=getpwnam("nobody");
    if(!user||!user->pw_uid||!user->pw_gid)return 3;
    const uid_t uid=user->pw_uid;const gid_t gid=user->pw_gid;
    if(setgroups(0,NULL)||setgid(gid)||setuid(uid))return 4;
    if(getuid()!=uid||geteuid()!=uid||getgid()!=gid||getegid()!=gid||getgroups(0,NULL)!=0)return 5;
    printf("permission-reader:uid=%lu gid=%lu\n",(unsigned long)uid,(unsigned long)gid);
    int fd=open(argv[2],O_RDONLY);
    if(!strcmp(argv[1],"deny"))return fd==-1&&errno==EACCES?0:6;
    if(strcmp(argv[1],"allow")||fd<0)return 7;
    char bytes[128];ssize_t n=read(fd,bytes,sizeof(bytes));
    if(close(fd)||n!=17||memcmp(bytes,"permission-proof\n",17))return 8;
    puts("permission-reader:content=verified");return 0;
}
