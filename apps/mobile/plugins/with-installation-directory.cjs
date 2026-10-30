const { withAppDelegate } = require('expo/config-plugins');

module.exports = function withInstallationDirectory(config) {
  return withAppDelegate(config, result => {
    if (result.modResults.language !== 'swift') throw new Error('The i7y installation directory requires a Swift AppDelegate');
    const marker = 'let delegate = ReactNativeDelegate()';
    if (result.modResults.contents.includes('i7y-private')) return result;
    if (!result.modResults.contents.includes(marker)) throw new Error('Unable to configure the i7y installation directory');
    const initialize = `do {
      var directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("i7y-private", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var attributes = URLResourceValues()
      attributes.isExcludedFromBackup = true
      try directory.setResourceValues(attributes)
    } catch {
      fatalError("Unable to prepare private application storage")
    }
    `;
    result.modResults.contents = result.modResults.contents.replace(marker, initialize + marker);
    return result;
  });
};
