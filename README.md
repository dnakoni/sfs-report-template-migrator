# Service Report Template Migrator

Tool to migrate Service Report Templates between orgs. This is an EXPERIMENTAL tool. Please test in developer sandboxes or scratch orgs first.

## Overview

This tool automates the migration process of Service Report Templates between Salesforce orgs since the Service Report Template type is not supported in the Metadata API. This script will run on your local computer and use Puppeteer/Chromium browser to grab the source org report template JSON (through looking through a POST request), and will then go to that report tab in the target org and intercept a POST request to plug in the correct report template JSON.

## Detailed Steps

This Node.js script does the following:

1. Use the `jsforce` package to login (using the SOAP API) to both source and target orgs (using username+password+security token) to get the access tokens.
2. Open up the target org (using `Puppeteer`/`Chromium`) to go to the new Service Report Template screen to create each new report and save.
3. Go to the Service Report Template list screen in the source org and open up a new browser tab for each report/report subtype to be migrated.
4. Grab the JSON definition of each report.
5. Extract any custom field IDs (and their parent object names or IDs) from the source reports.
6. Query the tooling API of the source org for the custom field/object IDs, then do the same for the target org, then finally create a map of source org => target org custom field IDs.
7. Use the source org => target org custom field ID map to replace all instances of the custom field IDs in the report JSON.
8. Go to the Service Report Template list screen of the target org, then go into each report that needs to be migrated and replace the JSON value of that report.

## Behind the Scenes

To grab the source JSON of a report, the script opens it up in a browser (and optionally switches to a different subtype, like `Service Appointment for Work Order Line Item`) and then clicks the Quick Save button on the templated editor screen. This fires off a POST request to save the report template to the server. This script looks at that post request and grabs the `jsonLayout` param of the URL-encoded body of the request. This param contains the entire body of the selected report template.

After replacing the custom field IDs in the JSON, the script then opens up the same report in the target org, and again clicks on the Quick Save button. But this time it intercepts the POST request, and replaces the `jsonLayout` param with a value from the source org.

## Installation

Make sure you have the latest version of node and npm installed on your system. This script has been tested with node 16.15.1 and npm 8.11.0 on both macOS 12.4 and Windows 10.

After downloading the repo, run npm install:
```zsh
npm install
```
Then populate the `.env` file with your source and target org login information (a sample file is in the repo):
```
SOURCE_ORG_USERNAME=
SOURCE_ORG_PASSWORD=
SOURCE_ORG_SECURITY_TOKEN=
SOURCE_ORG_LOGIN_URL=https://mydomainorg--sandbox1.my.salesforce.com
TARGET_ORG_USERNAME=
TARGET_ORG_PASSWORD=
TARGET_ORG_SECURITY_TOKEN=
TARGET_ORG_LOGIN_URL=https://mydomainorg--sandbox2.my.salesforce.com
```
The use of My Domain is REQUIRED.

Next, update the `config.yml` file with the names of the report templates that you want to migrate, example:
```yaml
reportNames:
  - "North America - With Signature"
  - "North America - Without Signature"
  - "Latin America - With Signature"
  - "Latin America - Without Signature"
```
That's it! Now just run the script and watch it work:
```zsh
node report_template_migrator.js
```

## Configuration

You can modify the `config.yml` file with a few options:

`reportNames` - the names of the report templates in the source org that will be migrated. Example:
```yaml
reportNames:
  - "North America - With Signature"
  - "North America - Without Signature"
  - "Latin America - With Signature"
  - "Latin America - Without Signature"
```

`reportSubtypesToMigrate` - this is a list of template subtypes that will be migrated. They map to the following subtypes visible in the UI:
```
"SA_WO"     => "Service Appointment for Work Order",
"SA_WOLI"   => "Service Appointment for Work Order Line Item",
"WO"        => "Work Order",
"WOLI"      => "Work Order Line Item"
```
If you only want to migrate one subtype, not all four, just comment out the others. E.g. if you only want to migrate `Service Appointment for Work Order Line Item`:
```yaml
reportSubtypesToMigrate:
  # - "SA_WO"
  - "SA_WOLI"
  # - "WO"
  # - "WOLI"
```

`createReportsInTargetOrg` - if set to True, the script will manually create the report templates in the target org, using the names specified in `reportNames`. If a report with a given name already exists in the target org, this script will not create a duplicate one, so this setting can always be set to True.

`runInBackground` - if set to True, the script will not open a visible `Puppeteer`/`Chromium` and will do everything behind the scenes instead. I recommend setting this to False so that you can watch the script work.

`writePOSTDataToFile` - if set to True the script will save the source report template to a local text file (in the same folder as the script) so that you can examine it. It will also write a second file with the converted JSON that will be saved in the target org. The only difference between those files should be custom field IDs and the removal of images, more on that below.

`errorLogFilename` - the name of the error log file to use. The only errors logged for now are when there is a login issue, or if there is a custom object or a custom field missing in the target org.

`windowWidth` - the window width, in pixels, of the Chromium browser (if not running in background mode)

`windowHeight` - the window height, in pixels, of the Chromium browser (if not running in background mode)

`timeoutBetweenActions` - the delay, in milliseconds, between separate script actions. The ideal value depends on your machine's CPU speed and network connection. The best value seems to be between 2000 - 6000.

`removeSourceImages` - if set to True, the script will remove any images from the source template. Migrating a service report template that contains an image added using the Upload Image feature throws an internal server error in the target org. If set to False, please make sure to remove the images manually from the source template before migrating. Images added to the report template using the Web Address feature are fine and do not have to be removed.

`imageReplacementText` - the text to replace an image with (if `removeSourceImages` is set to True). If set to a blank string the image will be removed without replacing it with text.

## Future possible enhancements

- [ ] Add OAuth
- [ ] Bulkify the Tooling API queries

## Authors

* **Daniel Nakonieczny** - *Initial work* - [dnakoni](https://github.com/dnakoni)

## License

See [license](LICENSE) (MIT License).