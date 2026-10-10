#ifndef LENGTH3_PACKET_NAT_H
#define LENGTH3_PACKET_NAT_H
#include <stdint.h>
typedef struct packet_nat packet_nat;
packet_nat *packet_nat_open(const uint16_t *path);
int packet_nat_input(packet_nat *,const uint8_t *,int);
int packet_nat_read(packet_nat *,uint8_t *,int);
const char *packet_nat_version(packet_nat *);
void packet_nat_close(packet_nat *);
#endif
