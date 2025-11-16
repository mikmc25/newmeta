// rdhelper.js — RealDebrid cache check with endpoint disabled fallback

export async function checkRDCache(realDebridService, streams) {
    const results = {};
    const validStreams = streams.filter(s => s && s.hash);

    if (validStreams.length === 0) {
        console.log('🔍 RealDebrid: No valid streams to check');
        return results;
    }

    // Extract hashes from streams
    const hashes = validStreams.map(s => s.hash.toLowerCase());
    
    console.log(`🔍 RealDebrid: Checking cache status for ${hashes.length} hashes`);

    try {
        // Use the updated class method instead of direct API calls
        const cacheResults = await realDebridService.checkInstantAvailability(hashes);

        // Check if endpoint is disabled by looking at first result
        const firstHash = hashes[0];
        const firstResult = cacheResults[firstHash];
        const endpointDisabled = firstResult?.error?.includes('endpoint disabled') || 
                                firstResult?.error?.includes('ENDPOINT_DISABLED');

        if (endpointDisabled) {
            console.log('🚨 RealDebrid instantAvailability endpoint is DISABLED - showing ALL streams as potentially cached');
            
            // ENDPOINT DISABLED: Show ALL streams as cached with warning
            for (const stream of validStreams) {
                const hash = stream.hash.toLowerCase();
                results[hash] = {
                    cached: true, // FORCE as cached so nothing gets filtered out
                    hash,
                    magnetLink: stream.magnetLink,
                    filename: stream.filename || 'Unknown',
                    websiteTitle: `🔄 ${stream.websiteTitle || stream.filename || 'Unknown'}`,
                    quality: stream.quality || '',
                    size: stream.size || '',
                    source: 'RealDebrid (unverified)',
                    note: 'Cache status unknown - RD endpoint disabled'
                };
                console.log(`🔄 RealDebrid: Hash ${hash.substring(0, 8)}... - SHOWING (cache unverified)`);
            }
            
            console.log(`✅ RealDebrid: Showing ALL ${validStreams.length} streams (cache verification disabled)`);
            return results;
        }

        // NORMAL PROCESSING: Endpoint is working
        for (const stream of validStreams) {
            const hash = stream.hash.toLowerCase();
            const cacheResult = cacheResults[hash];

            if (cacheResult && cacheResult.cached) {
                results[hash] = {
                    cached: true,
                    hash,
                    magnetLink: stream.magnetLink,
                    filename: stream.filename || 'Unknown',
                    websiteTitle: stream.websiteTitle || stream.filename || 'Unknown',
                    quality: stream.quality || '',
                    size: stream.size || '',
                    source: stream.source || 'RealDebrid'
                };
                console.log(`✅ RealDebrid: Hash ${hash.substring(0, 8)}... is cached`);
            } else {
                results[hash] = { 
                    cached: false,
                    error: cacheResult?.error || 'Not cached or unavailable'
                };
                console.log(`❌ RealDebrid: Hash ${hash.substring(0, 8)}... is NOT cached`);
            }
        }

    } catch (err) {
        console.error(`❌ RealDebrid cache check failed:`, err.message);
        
        // FALLBACK: If anything fails, show ALL streams
        console.log('🚨 RealDebrid cache check FAILED - showing ALL streams as potentially cached');
        
        for (const stream of validStreams) {
            const hash = stream.hash.toLowerCase();
            results[hash] = {
                cached: true, // FORCE as cached so nothing gets filtered out
                hash,
                magnetLink: stream.magnetLink,
                filename: stream.filename || 'Unknown',
                websiteTitle: `❓ ${stream.websiteTitle || stream.filename || 'Unknown'}`,
                quality: stream.quality || '',
                size: stream.size || '',
                source: 'RealDebrid (error)',
                error: `Cache check failed: ${err.message}`
            };
        }
        
        console.log(`✅ RealDebrid: Showing ALL ${validStreams.length} streams (fallback mode)`);
    }

    return results;
}