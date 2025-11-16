// debrids.js
import { DebridLink } from './debridlink.js';
import { Premiumize } from './premiumize.js';
import { TorBox } from './torbox.js';
import { RealDebrid } from './realdebrid.js';

export function getDebridServices(apiKeys) {
    console.log('\n🔐 Initializing debrid services with keys:', apiKeys);
    const services = [];
    
    for (const key of apiKeys.split(',')) {
        if (DebridLink.canHandle(key)) {
            console.log('Adding DebridLink service');
            services.push(new DebridLink(key));
        } else if (Premiumize.canHandle(key)) {
            console.log('Adding Premiumize service');
            services.push(new Premiumize(key));
        } else if (TorBox.canHandle(key)) {
            console.log('Adding TorBox service');
            services.push(new TorBox(key));
        } else if (RealDebrid.canHandle(key)) {
            console.log('Adding Real-Debrid service');
            services.push(new RealDebrid(key));
        } else {
            console.log('Unknown service key format:', key);
        }
    }
    
    console.log(`Initialized ${services.length} debrid services`);
    return services;
}

export { DebridLink, Premiumize, TorBox, RealDebrid };