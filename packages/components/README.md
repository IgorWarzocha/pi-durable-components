# Durable Components

Offer independently versioned Durable components in your app without importing Howcode. Read catalogue and package descriptors as data, check runtime and capability compatibility, then construct and bind components through the public activation contract.

The root export provides descriptor and catalogue parsers, compatibility checks, typed host capability grants and lifecycle contracts. Package activation entries use `createComponent(request)` and return ordinary Durable extensions, Models providers or a service API. Hosts retain ownership of installation, registry publication, user selections and scheduling.

Capabilities are explicit in-process grants, not a sandbox. Models owns credentials. Native process, filesystem, network, browser and audio permissions belong to the host. Missing capabilities stay unavailable rather than falling back to ambient machine access.

Use `prepareComponents` to construct registrations before opening the Harness. Publish the returned extensions and providers through your existing owners. Bind components to that Harness and its storage before resuming stored work. Keep retired Harness-lifetime generations alive and include them in maintenance.

For live retirement, supply a real `whenIdle` observation barrier. The coordinator first stops background admission through optional `stopAdmission` hooks without cancelling accepted work. For explicit shutdown, stop host ingress, call `closeBeforeHarness`, close the Harness, then call `closeAfterHarness`. Before-close hooks can cancel owned resources while the Harness is available. After-close hooks wait for its actual closure. Cleanup failures retain ownership for retry. Do not replay interrupted side effects.

The Node-only `./node` entry exports `inspectRegistryComponent`. It verifies exact npm package metadata and SRI-protected archive bytes, then reads the package descriptor without importing, extracting or running it. The root entry stays portable. Neither entry installs packages or changes user selections.

Run the [standalone host example](https://github.com/IgorWarzocha/pi-durable-components/tree/main/examples/marketplace) to exercise activation, native input placement, retained ownership and shutdown without Howcode or a live provider.

See the repository's [marketplace guide](https://github.com/IgorWarzocha/pi-durable-components/blob/main/docs/marketplace.md) for the full host integration boundary.
